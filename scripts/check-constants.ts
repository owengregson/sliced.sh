// scripts/check-constants.ts — C1 lint: no duplicated registry literals (§4.1 rule 4),
// plus the §13.3 rule 2 / §9 page-realm API ban.
//
// Scans `src/**/*.ts` (not `.d.ts`, not generated/) for
//   (a) string literals matching the namespaced prefixes (`sl::`, `sl:`, `sl-`, `__sl_`)
//       that are defined in a registry file and re-declared anywhere else,
//   (b) numeric literals annotated with a `// const: <Name>` marker outside a registry
//       file (the marker means "this number belongs in a registry"), and
//   (c) under `src/content/**` and `src/page/**` only: any occurrence of a forbidden page
//       API (page storage, synthetic input events, speech, tab/window manipulation) —
//       comments included, so the words never appear there at all,
//   (d) the emitted page programs (`src/page/generated/<name>.ts`, written by
//       `gen:pagescript` earlier in the pipeline): the `code` a MAIN-world script ships must
//       contain none of the §13.3 rule 5 product/engine words (Task 33).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REGISTRY_DIRS = ["src/core/constants/", "src/design/", "src/content/adapters/selectors.ts"];
const LITERAL_RE = /(["'`])((?:sl::|sl:|sl-|__sl_)[A-Za-z0-9:_\-.]+)\1/g;
const CONST_MARKER_RE = /\/\/\s*const:\s*([A-Za-z_$][\w$.]*)?/;
const NUMBER_RE = /(?<![\w$.])\d[\d_]*(?:\.\d+)?(?![\w$])/g;

export interface Duplicate {
	file: string;
	literal: string;
	definedIn: string;
}

/** Directories whose sources run in or beside the host page (§13.3 rule 2). */
const PAGE_REALM_DIRS = ["src/content/", "src/page/"];

/** APIs that must never appear under the page-realm directories (§13.3 rule 2, §9). */
export const FORBIDDEN_PAGE_APIS = [
	"localStorage",
	"sessionStorage",
	"indexedDB",
	"document.cookie",
	"dispatchEvent",
	"new PointerEvent",
	"new MouseEvent",
	"speechSynthesis",
	"chrome.tabs.update",
	"chrome.tabs.create",
	"chrome.notifications",
	"window.open",
] as const;

/** Words that must never appear in an emitted page program (§13.3 rule 5). Case-sensitive, as listed. */
export const FORBIDDEN_PAGE_SUBSTRINGS = [
	"sliced",
	"engine",
	"stockfish",
	"eval",
	"bestmove",
	"fen",
	"analysis",
] as const;

/** Directory `gen:pagescript` writes the emitted programs to (repo-relative). */
export const GENERATED_PAGE_DIR = "src/page/generated/";

export interface ForbiddenApiHit {
	file: string;
	api: string;
	line: number;
}

/** Every forbidden-API occurrence in the page-realm files of `files` (repo-relative keys). */
export function findForbiddenPageApis(files: Record<string, string>): ForbiddenApiHit[] {
	const out: ForbiddenApiHit[] = [];
	for (const [file, src] of Object.entries(files)) {
		if (!PAGE_REALM_DIRS.some((d) => file.startsWith(d))) continue;
		const lines = src.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i] ?? "";
			for (const api of FORBIDDEN_PAGE_APIS) {
				if (line.includes(api)) out.push({ file, api, line: i + 1 });
			}
		}
	}
	return out;
}

/** The forbidden words present in `code`. */
export function findForbiddenSubstrings(code: string): string[] {
	return FORBIDDEN_PAGE_SUBSTRINGS.filter((w) => code.includes(w));
}

export interface ForbiddenProgramHit {
	file: string;
	word: string;
}

const CODE_EXPORT_RE = /^export const code = (".*");$/m;

/**
 * The emitted `code` of every generated page program in `files` (keys under
 * `GENERATED_PAGE_DIR`) that contains a forbidden word. A generated module without a
 * parsable `code` export is reported as a hit on `"<unreadable>"` so it can never pass unseen.
 */
export function findForbiddenProgramSubstrings(
	files: Record<string, string>
): ForbiddenProgramHit[] {
	const out: ForbiddenProgramHit[] = [];
	for (const [file, src] of Object.entries(files)) {
		if (!file.startsWith(GENERATED_PAGE_DIR) || !file.endsWith(".ts")) continue;
		const m = CODE_EXPORT_RE.exec(src);
		let code: unknown;
		try {
			code = m ? JSON.parse(m[1] ?? "") : undefined;
		} catch {
			code = undefined;
		}
		if (typeof code !== "string") {
			out.push({ file, word: "<unreadable>" });
			continue;
		}
		for (const word of findForbiddenSubstrings(code)) out.push({ file, word });
	}
	return out;
}

function isRegistryFile(f: string): boolean {
	return REGISTRY_DIRS.some((d) => f.startsWith(d) || f === d);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Registry file that mentions the marker's name (last dotted segment), else the registry dir. */
function registryFor(name: string | undefined, registries: Array<[string, string]>): string {
	const fallback = REGISTRY_DIRS[0] ?? "";
	if (!name) return fallback;
	const leaf = name.split(".").pop();
	if (!leaf) return fallback;
	const re = new RegExp(`\\b${escapeRe(leaf)}\\b`);
	const hit = registries.find(([, src]) => re.test(src));
	return hit ? hit[0] : fallback;
}

function markedNumbers(
	file: string,
	src: string,
	registries: Array<[string, string]>,
	out: Duplicate[]
): void {
	for (const line of src.split("\n")) {
		const marker = CONST_MARKER_RE.exec(line);
		if (!marker) continue;
		const code = line.slice(0, marker.index);
		const definedIn = registryFor(marker[1], registries);
		for (const m of code.matchAll(NUMBER_RE)) out.push({ file, literal: m[0], definedIn });
	}
}

export function findDuplicateLiterals(files: Record<string, string>): Duplicate[] {
	const entries = Object.entries(files);
	const registries = entries.filter(([f]) => isRegistryFile(f));
	const defined = new Map<string, string>();
	for (const [f, src] of registries)
		for (const m of src.matchAll(LITERAL_RE)) {
			const literal = m[2];
			if (literal !== undefined && !defined.has(literal)) defined.set(literal, f);
		}
	const out: Duplicate[] = [];
	for (const [f, src] of entries) {
		if (isRegistryFile(f)) continue;
		for (const m of src.matchAll(LITERAL_RE)) {
			const literal = m[2];
			if (literal === undefined) continue;
			const def = defined.get(literal);
			if (def) out.push({ file: f, literal, definedIn: def });
		}
		markedNumbers(f, src, registries, out);
	}
	return out;
}

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Collect `*.ts` sources keyed by repo-relative posix path (so REGISTRY_DIRS match). */
function walk(dir: string, acc: Record<string, string>, includeGenerated = false): void {
	for (const e of readdirSync(dir)) {
		const p = path.join(dir, e);
		if (statSync(p).isDirectory()) {
			if (/node_modules/.test(p)) continue;
			if (/generated/.test(p) && !includeGenerated) continue;
			walk(p, acc, includeGenerated);
		} else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) {
			acc[path.relative(REPO_ROOT, p).split(path.sep).join("/")] = readFileSync(p, "utf8");
		}
	}
}

/** The emitted page programs; fails closed when `gen:pagescript` has not run. */
export function checkEmittedPrograms(generatedDir = GENERATED_PAGE_DIR): void {
	const dir = path.resolve(REPO_ROOT, generatedDir);
	if (!existsSync(dir)) {
		throw new Error(
			`${generatedDir} is missing: run \`bun run gen:pagescript\` before check-constants (the emitted page programs are scanned for forbidden words)`
		);
	}
	const files: Record<string, string> = {};
	walk(dir, files, true);
	const hits = findForbiddenProgramSubstrings(files);
	if (hits.length) {
		for (const h of hits)
			console.error(`forbidden word "${h.word}" in emitted page program ${h.file} (§13.3 rule 5)`);
		throw new Error(`${hits.length} forbidden word(s) in emitted page programs`);
	}
}

export function checkConstants(root = "src"): void {
	const files: Record<string, string> = {};
	walk(path.resolve(REPO_ROOT, root), files);
	const dups = findDuplicateLiterals(files);
	if (dups.length) {
		for (const d of dups)
			console.error(`duplicate constant "${d.literal}" in ${d.file} (defined in ${d.definedIn})`);
		throw new Error(`${dups.length} duplicated constant(s)`);
	}
	const hits = findForbiddenPageApis(files);
	if (hits.length) {
		for (const h of hits)
			console.error(`forbidden page API "${h.api}" in ${h.file}:${h.line} (§13.3 rule 2)`);
		throw new Error(`${hits.length} forbidden page API use(s)`);
	}
	checkEmittedPrograms();
}

if (import.meta.main) checkConstants();
