// scripts/verify-dist.ts — build step 10 (§11.2): the packaged tree is loadable and clean.
//
// Five families of check, all against `dist/` as it will be zipped:
//
//   1. every path the stamped manifest declares exists (globs in
//      `web_accessible_resources` must match at least one file);
//   2. every same-origin reference reachable from the extension's HTML resolves —
//      `src`/`href` in the pages, then `url(…)` and `@import` transitively through the CSS,
//      so a missing font or an unstamped stylesheet fails the build instead of the panel;
//   3. bundle sizes are reported and the two budgeted entries are capped
//      (`js/panel.js` 400 KB, `js/content.js` 250 KB — §11.2);
//   4. no `console.` survives in a production bundle (`@core/logger` is the only sanctioned
//      console use and reaches it through a computed member, `console[level]`, so a literal
//      `console.` in a shipped bundle is always a stray call);
//   5. the licence host (`build.config.json` → `licenseUrl`) appears only in the service-worker
//      bundle. The licence client runs in the SW; the same string in `content.js` would put the
//      vendor's hostname on chess.com's origin, which is a free detection signal (§13.3).
//
// Everything below the `verifyDist` entry point is a pure function over strings so
// `test/scripts/verify-dist.test.ts` can exercise the rules without a real build.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import config from "../build.config.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };

const KIB = 1024;

/** §11.2 bundle budgets, keyed by dist-relative posix path. */
export const BUNDLE_BUDGETS: Readonly<Record<string, number>> = {
	"js/panel.js": 400 * KIB,
	"js/content.js": 250 * KIB,
};

/** The one bundle allowed to carry the licence host: the licence client runs in the SW. */
export const LICENSE_BUNDLE = "js/service-worker.js";

/** Manifest keys that must never come back (§12.2 drops the self-hosted CRX update feed). */
export const FORBIDDEN_MANIFEST_KEYS = ["update_url"] as const;

export interface VerifyOptions {
	/** Dev builds keep `console.` (the `--dev` bundle is not minified and is never shipped). */
	dev?: boolean;
	/** Version the stamped manifest must carry (default: `package.json`). */
	version?: string;
	/** Licence endpoint whose host is bundle-restricted (default: `build.config.json`). */
	licenseUrl?: string;
}

export interface SizeRow {
	file: string;
	bytes: number;
	budget: number | null;
}

export interface VerifyReport {
	sizes: SizeRow[];
	totalBytes: number;
	problems: string[];
}

// ── small readers (no `any`: the manifest and the HTML are untyped input) ───────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── 1. manifest paths ──────────────────────────────────────────────────────────────────────

export interface DeclaredPath {
	/** Extension-relative path exactly as the manifest spells it. */
	path: string;
	/** Where it came from, for the error message. */
	where: string;
	/** `web_accessible_resources` entries may be patterns; they must match ≥ 1 file. */
	glob: boolean;
}

/** Every extension-relative path the manifest declares. */
export function manifestPaths(manifest: unknown): DeclaredPath[] {
	const out: DeclaredPath[] = [];
	if (!isRecord(manifest)) return out;
	const push = (raw: unknown, where: string): void => {
		const p = asString(raw);
		if (p === null || p === "") return;
		out.push({ path: p, where, glob: p.includes("*") });
	};

	const icons = manifest.icons;
	if (isRecord(icons)) for (const [size, v] of Object.entries(icons)) push(v, `icons.${size}`);

	const action = manifest.action;
	if (isRecord(action)) {
		const icon = action.default_icon;
		if (isRecord(icon))
			for (const [size, v] of Object.entries(icon)) push(v, `action.default_icon.${size}`);
		else push(icon, "action.default_icon");
		push(action.default_popup, "action.default_popup");
	}

	const sidePanel = manifest.side_panel;
	if (isRecord(sidePanel)) push(sidePanel.default_path, "side_panel.default_path");

	const background = manifest.background;
	if (isRecord(background)) push(background.service_worker, "background.service_worker");

	const scripts = asArray(manifest.content_scripts);
	for (let i = 0; i < scripts.length; i += 1) {
		const entry = scripts[i];
		if (!isRecord(entry)) continue;
		const js = asArray(entry.js);
		for (let k = 0; k < js.length; k += 1) push(js[k], `content_scripts[${i}].js[${k}]`);
		const css = asArray(entry.css);
		for (let k = 0; k < css.length; k += 1) push(css[k], `content_scripts[${i}].css[${k}]`);
	}

	const war = asArray(manifest.web_accessible_resources);
	for (let i = 0; i < war.length; i += 1) {
		const entry = war[i];
		if (!isRecord(entry)) continue;
		const resources = asArray(entry.resources);
		for (let k = 0; k < resources.length; k += 1)
			push(resources[k], `web_accessible_resources[${i}].resources[${k}]`);
	}

	return out;
}

/**
 * Chrome's extension-resource patterns, where `*` spans path separators
 * (`assets/engine/*` covers a nested file just as it covers a flat one).
 */
export function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`);
}

/** Manifest-level problems: missing paths, a wrong version stamp, a resurrected `update_url`. */
export function checkManifest(
	manifest: unknown,
	files: readonly string[],
	expectedVersion: string | undefined
): string[] {
	const problems: string[] = [];
	if (!isRecord(manifest)) return ["manifest.json is not an object"];
	const present = new Set(files);

	if (manifest.manifest_version !== 3)
		problems.push(`manifest_version is ${String(manifest.manifest_version)}, expected 3`);
	if (expectedVersion !== undefined && manifest.version !== expectedVersion)
		problems.push(`manifest version is ${String(manifest.version)}, expected ${expectedVersion}`);
	if (asString(manifest.key) === null)
		problems.push("manifest has no `key` — the extension ID would not be stable (§12.2)");
	for (const key of FORBIDDEN_MANIFEST_KEYS)
		if (key in manifest) problems.push(`manifest declares \`${key}\` — dropped in v2 (§12.2)`);

	for (const declared of manifestPaths(manifest)) {
		if (declared.glob) {
			const re = globToRegExp(declared.path);
			if (!files.some((f) => re.test(f)))
				problems.push(`${declared.where}: "${declared.path}" matches no file in dist/`);
		} else if (!present.has(declared.path)) {
			problems.push(`${declared.where}: "${declared.path}" is missing from dist/`);
		}
	}
	return problems;
}

// ── 2. HTML / CSS reference graph ──────────────────────────────────────────────────────────

const HTML_REF_RE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/g;

/** References that leave the package (or address nothing) and so cannot be resolved on disk. */
export function isExternalRef(ref: string): boolean {
	return (
		ref === "" || ref.startsWith("#") || ref.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(ref) // http:, https:, data:, blob:, chrome-extension:, mailto:
	);
}

function collect(re: RegExp, text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(re)) {
		const value = m[1] ?? m[2] ?? m[3] ?? "";
		if (!isExternalRef(value)) out.push(value);
	}
	return out;
}

/** Same-package `src`/`href` targets in an HTML document. */
export function htmlRefs(html: string): string[] {
	return collect(HTML_REF_RE, html);
}

/**
 * Same-package `url(…)` and `@import` targets in a stylesheet, first appearance first.
 * `@import url("x.css")` matches both patterns, hence the dedupe.
 */
export function cssRefs(css: string): string[] {
	return [...new Set([...collect(CSS_URL_RE, css), ...collect(CSS_IMPORT_RE, css)])];
}

/**
 * Resolve a reference found in `fromFile` (dist-relative) to a dist-relative path, dropping any
 * `?query` / `#fragment` (font `src` values carry them). `null` when it escapes the package.
 */
export function resolveRef(fromFile: string, ref: string): string | null {
	const bare = ref.split(/[?#]/, 1)[0] ?? "";
	if (bare === "") return null;
	const base = path.posix.dirname(fromFile);
	const joined = bare.startsWith("/")
		? path.posix.normalize(bare.slice(1))
		: path.posix.normalize(path.posix.join(base, bare));
	return joined.startsWith("..") ? null : joined;
}

/**
 * Walk every HTML entry and the stylesheets it reaches, reporting unresolvable references.
 * `read` returns the text of a dist-relative file, or `null` when it does not exist.
 */
export function checkReferenceGraph(
	entries: readonly string[],
	read: (file: string) => string | null
): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	const queue = [...entries];
	while (queue.length > 0) {
		const file = queue.shift();
		if (file === undefined || seen.has(file)) continue;
		seen.add(file);
		const text = read(file);
		if (text === null) continue; // reported by whoever referenced it
		const refs = file.endsWith(".css") ? cssRefs(text) : htmlRefs(text);
		for (const ref of refs) {
			const target = resolveRef(file, ref);
			if (target === null) {
				problems.push(`${file}: "${ref}" resolves outside dist/`);
				continue;
			}
			if (read(target) === null) {
				problems.push(`${file}: "${ref}" → ${target} is missing from dist/`);
				continue;
			}
			if (target.endsWith(".css") || target.endsWith(".html")) queue.push(target);
		}
	}
	return problems;
}

// ── 3–5. bundle content ────────────────────────────────────────────────────────────────────

/** Host of the licence endpoint, or `null` when `licenseUrl` is not an absolute URL. */
export function licenseHost(licenseUrl: string): string | null {
	try {
		return new URL(licenseUrl).hostname;
	} catch {
		return null;
	}
}

/** Line number (1-based) of the first occurrence of `needle`, or 0. */
function firstLine(text: string, needle: string): number {
	const at = text.indexOf(needle);
	return at < 0 ? 0 : text.slice(0, at).split("\n").length;
}

export interface ScanOptions {
	dev: boolean;
	host: string | null;
}

/** Content rules for one shipped bundle (§11.2 step 10). */
export function scanBundle(file: string, text: string, options: ScanOptions): string[] {
	const problems: string[] = [];
	if (!options.dev) {
		const hits = text.match(/console\./g)?.length ?? 0;
		if (hits > 0)
			problems.push(
				`${file}: ${hits} \`console.\` call(s) in a production bundle (first at line ${firstLine(text, "console.")})`
			);
	}
	const host = options.host;
	if (host !== null && file !== LICENSE_BUNDLE && text.includes(host))
		problems.push(
			`${file}: contains the licence host "${host}" — it belongs only in ${LICENSE_BUNDLE}`
		);
	return problems;
}

// ── the build step ─────────────────────────────────────────────────────────────────────────

/** Every file under `dir`, as dist-relative posix paths. */
export function walkFiles(dir: string, base = dir, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) walkFiles(full, base, acc);
		else acc.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return acc;
}

function formatBytes(bytes: number): string {
	if (bytes >= KIB * KIB) return `${(bytes / (KIB * KIB)).toFixed(1)} MiB`;
	return `${(bytes / KIB).toFixed(1)} KiB`;
}

/**
 * Verify the built tree. Prints the size report, then throws with every problem listed —
 * the build must not produce a zip nobody can load.
 */
export function verifyDist(dist: string, options: VerifyOptions = {}): VerifyReport {
	const dev = options.dev === true;
	const version = options.version ?? pkg.version;
	const host = licenseHost(options.licenseUrl ?? config.licenseUrl);

	const files = walkFiles(dist).sort();
	const present = new Set(files);
	const read = (file: string): string | null =>
		present.has(file) ? readFileSync(path.join(dist, file), "utf8") : null;

	const problems: string[] = [];

	// 1. manifest
	const manifestText = read("manifest.json");
	if (manifestText === null) {
		problems.push("manifest.json is missing from dist/ (the stamp step did not run)");
	} else {
		let manifest: unknown;
		try {
			manifest = JSON.parse(manifestText);
		} catch (error) {
			manifest = null;
			problems.push(`manifest.json is not valid JSON: ${String(error)}`);
		}
		if (manifest !== null) problems.push(...checkManifest(manifest, files, version));
	}

	// 2. HTML → CSS → asset graph
	problems.push(
		...checkReferenceGraph(
			files.filter((f) => f.endsWith(".html")),
			read
		)
	);

	// 3. sizes (every shipped script; source maps are dev-only and not part of the budget)
	const scripts = files.filter((f) => f.startsWith("js/") && f.endsWith(".js"));
	const sizes: SizeRow[] = scripts.map((file) => ({
		file,
		bytes: statSync(path.join(dist, file)).size,
		budget: BUNDLE_BUDGETS[file] ?? null,
	}));
	for (const row of sizes)
		if (row.budget !== null && row.bytes > row.budget)
			problems.push(
				`${row.file} is ${formatBytes(row.bytes)}, over its ${formatBytes(row.budget)} budget (§11.2)`
			);
	for (const budgeted of Object.keys(BUNDLE_BUDGETS))
		if (!present.has(budgeted)) problems.push(`${budgeted} was not built`);

	// 4–5. bundle content
	for (const file of scripts) {
		const text = read(file);
		if (text !== null) problems.push(...scanBundle(file, text, { dev, host }));
	}

	const totalBytes = files.reduce((sum, f) => sum + statSync(path.join(dist, f)).size, 0);
	const width = Math.max(...sizes.map((r) => r.file.length), 20);
	console.log(`verify-dist: ${files.length} files, ${formatBytes(totalBytes)} unpacked`);
	for (const row of sizes)
		console.log(
			`  ${row.file.padEnd(width)}  ${formatBytes(row.bytes).padStart(10)}${
				row.budget === null ? "" : ` / ${formatBytes(row.budget)}`
			}`
		);

	if (problems.length > 0)
		throw new Error(
			`verify-dist: ${problems.length} problem(s) in ${dist}\n  - ${problems.join("\n  - ")}`
		);
	return { sizes, totalBytes, problems };
}

if (import.meta.main) {
	const args = new Set(process.argv.slice(2));
	verifyDist(path.resolve(import.meta.dir, "..", "dist"), { dev: args.has("--dev") });
}
