// scripts/verify-dist.ts — build step 10 (§11.2): the packaged tree is loadable and clean.
//
// Seven families of check, all against `dist/` as it will be zipped:
//
//   1. every path the stamped manifest declares exists (globs in
//      `web_accessible_resources` must match at least one file);
//   2. the manifest exposes nothing to the page. `web_accessible_resources` must be absent, or
//      every entry must carry `use_dynamic_url: true`. The manifest pins `key`, so the extension
//      id is fixed and knowable: any script on a matched site could `fetch()` a web-accessible
//      path and read success as a definitive "sliced is installed" — the strongest presence
//      signal §13.3 exists to prevent, and stronger than any inlined string. `use_dynamic_url`
//      rotates the token per session, which is the only form that is safe to reintroduce;
//   3. every same-origin reference reachable from the extension's HTML resolves —
//      `src`/`href` in the pages, then `url(…)` and `@import` transitively through the CSS,
//      so a missing font or an unstamped stylesheet fails the build instead of the panel;
//   4. bundle sizes are reported and the two budgeted entries are capped
//      (`js/panel.js` 400 KB, `js/content.js` 250 KB — §11.2);
//   5. no `console.` survives in a production bundle (`@core/logger` is the only sanctioned
//      console use and reaches it through a computed member, `console[level]`, so a literal
//      `console.` in a shipped bundle is always a stray call);
//   6. **host ownership**: every host that appears in the constants registry may appear only in
//      the bundles `HOST_OWNERS` names, and a host that is not in that table fails the build —
//      so adding a URL forces a decision about which realms may see it, instead of a bundler
//      quietly inlining an object literal into `content.js` (§13.3 rule 2);
//   7. a production build ships no `.js.map`. Dev maps embed `sourcesContent`, i.e. the original
//      TypeScript including comments that name the licence endpoint, so they are checked for
//      absence rather than scanned — see `SOURCE_MAP_RE` below.
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

/** Bundle roles, as dist-relative paths (`HOST_OWNERS` keys off them). */
export const BUNDLES = {
	serviceWorker: "js/service-worker.js",
	panel: "js/panel.js",
	offscreen: "js/offscreen.js",
	content: "js/content.js",
} as const;

/** The one bundle allowed to carry the licence host: the licence client runs in the SW. */
export const LICENSE_BUNDLE = BUNDLES.serviceWorker;

const SW_AND_PANEL = [BUNDLES.serviceWorker, BUNDLES.panel] as const;

/**
 * Which bundles may carry each host found in `src/core/constants/**` (plus the build config's
 * licence endpoint). A derived host that is missing from this table fails the build: classifying
 * a new URL is the point of the rule, not a formality.
 *
 * The service worker owns every outbound request; the panel carries the whole registry because
 * `src/panel/actions.ts` imports `URLS` as an object to resolve `data-url="…"` links, and a
 * bundler inlines an object literal whole. Neither is reachable from a page — the panel and the
 * offscreen document are extension pages. What must stay empty is the page realm: `content.js`
 * runs in the ISOLATED world on the site's own origin, and `js/page/*.js` run in MAIN.
 */
export const HOST_OWNERS: Readonly<Record<string, readonly string[]>> = {
	// Licence vendor — the client runs only in the SW.
	"phantom.ac": [BUNDLES.serviceWorker],
	// Product site: the update poll (SW) and the panel's links.
	"sliced.sh": SW_AND_PANEL,
	// NNUE mirror and its redirect target — both fetched by the SW.
	"tests.stockfishchess.org": SW_AND_PANEL,

	"data.stockfishchess.org": SW_AND_PANEL,
	// The two sites, as navigable links in the panel's Not-supported view.
	"www.chess.com": SW_AND_PANEL,
	"lichess.org": SW_AND_PANEL,
	// Upstream metadata for the vendored components (licence notices, not requests).
	"github.com": SW_AND_PANEL,
	"raw.githubusercontent.com": SW_AND_PANEL,
	"polyformproject.org": SW_AND_PANEL,
	"1e4.ai": SW_AND_PANEL,
};

/** Registry sources scanned for hosts (repo-relative). */
export const REGISTRY_DIR = "src/core/constants";

/** Source maps must never reach a release package. */
const SOURCE_MAP_RE = /\.js\.map$/;

/** Manifest keys that must never come back (§12.2 drops the self-hosted CRX update feed). */
export const FORBIDDEN_MANIFEST_KEYS = ["update_url"] as const;

export interface VerifyOptions {
	/** Dev builds keep `console.` (the `--dev` bundle is not minified and is never shipped). */
	dev?: boolean;
	/** Version the stamped manifest must carry (default: `package.json`). */
	version?: string;
	/** Licence endpoint whose host is bundle-restricted (default: `build.config.json`). */
	licenseUrl?: string;
	/** Hosts to police (default: derived from `REGISTRY_DIR` + `licenseUrl`); injectable for tests. */
	hosts?: readonly string[];
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
	problems.push(...checkWebAccessibleResources(manifest));

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

/**
 * §13.3: the manifest pins `key`, so the extension id is fixed and any script on a matched site
 * can probe `fetch("chrome-extension://<id>/<path>")` for a web-accessible resource; a success is
 * a definitive presence signal. v2 declares none — the engine assets are loaded by the offscreen
 * document and the sounds by the side panel, both of which are extension pages that need no
 * declaration (`grep -r "runtime.getURL" src/content src/page` is empty). If the block ever
 * returns, every entry must carry `use_dynamic_url: true`, which rotates the URL token per
 * session and makes the probe useless.
 */
export function checkWebAccessibleResources(manifest: unknown): string[] {
	if (!isRecord(manifest)) return [];
	const declared = manifest.web_accessible_resources;
	if (declared === undefined) return [];
	const entries = asArray(declared);
	// A present-but-unreadable declaration is not a pass. Chrome rejects such a manifest at load,
	// but this rule must not be the thing that waved it through.
	if (entries.length === 0)
		return [
			"web_accessible_resources is present but is not a non-empty array — it must be absent, or an array whose every entry sets `use_dynamic_url: true` (§13.3)",
		];
	const problems: string[] = [];
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		const resources = isRecord(entry) ? asArray(entry.resources).join(", ") : String(entry);
		if (!isRecord(entry) || entry.use_dynamic_url !== true)
			problems.push(
				`web_accessible_resources[${i}] (${resources}) has no \`use_dynamic_url: true\` — a fixed extension id plus a web-accessible path is a presence probe from any matched site (§13.3)`
			);
	}
	return problems;
}

// ── 3. HTML / CSS reference graph ──────────────────────────────────────────────────────────

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

// ── 4–7. bundle content ────────────────────────────────────────────────────────────────────

/** Host of the licence endpoint, or `null` when `licenseUrl` is not an absolute URL. */
export function licenseHost(licenseUrl: string): string | null {
	try {
		return new URL(licenseUrl).hostname;
	} catch {
		return null;
	}
}

const URL_LITERAL_RE = /https?:\/\/([A-Za-z0-9.-]+)/g;

/**
 * Every distinct host mentioned by an absolute URL in the registry sources, plus the licence
 * endpoint's. Sorted, so the failure message is stable.
 */
export function registryHosts(
	sources: Record<string, string>,
	licenseUrl: string | null
): string[] {
	const hosts = new Set<string>();
	for (const text of Object.values(sources))
		for (const m of text.matchAll(URL_LITERAL_RE)) if (m[1]) hosts.add(m[1]);
	const licence = licenseUrl === null ? null : licenseHost(licenseUrl);
	if (licence !== null) hosts.add(licence);
	return [...hosts].sort();
}

/**
 * A host is looked for as `//<host>`, not bare: `*://*.lichess.org/*` is a match pattern, not a
 * URL, and the content script legitimately carries both site patterns. Only a real absolute URL
 * literal has the `//` in front of the host.
 */
export function hostNeedle(host: string): string {
	return `//${host}`;
}

/** Hosts derived from the registry that `HOST_OWNERS` does not classify. */
export function unclassifiedHosts(hosts: readonly string[]): string[] {
	return hosts.filter((h) => HOST_OWNERS[h] === undefined);
}

/** Line number (1-based) of the first occurrence of `needle`, or 0. */
function firstLine(text: string, needle: string): number {
	const at = text.indexOf(needle);
	return at < 0 ? 0 : text.slice(0, at).split("\n").length;
}

export interface ScanOptions {
	dev: boolean;
	/** Hosts derived from the constants registry; each is looked up in `HOST_OWNERS`. */
	hosts: readonly string[];
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
	for (const host of options.hosts) {
		const needle = hostNeedle(host);
		if (!text.includes(needle)) continue;
		const owners = HOST_OWNERS[host];
		if (owners === undefined) continue; // reported once, by `unclassifiedHosts`
		if (!owners.includes(file))
			problems.push(
				`${file}: contains the registry host "${host}" — HOST_OWNERS allows it only in ${
					owners.length === 0 ? "no bundle" : owners.join(", ")
				} (§13.3)`
			);
	}
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

/** The constants registry's sources, keyed by file name. */
export function readRegistry(
	dir = path.resolve(import.meta.dir, "..", REGISTRY_DIR)
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of readdirSync(dir))
		if (entry.endsWith(".ts")) out[entry] = readFileSync(path.join(dir, entry), "utf8");
	return out;
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
	const hosts =
		options.hosts ?? registryHosts(readRegistry(), options.licenseUrl ?? config.licenseUrl);

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

	// 5–6. bundle content. A host the registry introduced but `HOST_OWNERS` does not classify is
	// reported once here rather than per bundle: the fix is to classify it, not to move it.
	for (const host of unclassifiedHosts(hosts))
		problems.push(
			`registry host "${host}" is not in HOST_OWNERS — add it to scripts/verify-dist.ts and say which bundles may carry it (§13.3)`
		);
	for (const file of scripts) {
		const text = read(file);
		if (text !== null) problems.push(...scanBundle(file, text, { dev, hosts }));
	}

	// 7. no source maps in a release package (they embed the original TypeScript).
	if (!dev)
		for (const file of files.filter((f) => SOURCE_MAP_RE.test(f)))
			problems.push(`${file}: a production build must ship no source map`);

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
