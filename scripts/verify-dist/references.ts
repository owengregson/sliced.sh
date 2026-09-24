// scripts/verify-dist/references.ts — rule 3: every same-origin reference reachable from the
// extension's HTML resolves — `src`/`href` in the pages, then `url(…)` and `@import`
// transitively through the CSS, so a missing font or an unstamped stylesheet fails the build
// instead of the panel.

import path from "node:path";

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
