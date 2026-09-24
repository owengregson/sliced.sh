// scripts/check-constants/urls.ts — C1 for URLs.
//
// Every absolute URL belongs in the registry, so `verify-dist`'s host rule (which derives its
// host list from `src/core/constants/`) can classify it and keep it out of the page realm. A
// URL written straight into, say, `src/content/foo.ts` is invisible to that rule and would ship
// into `content.js` unnoticed — the §13.3 leak class this exists to close.
//
// Generated page programs are excluded: they are emitted, not authored, and their contents are
// already policed by `findForbiddenProgramSubstrings`.
//
// The scan is textual, so it catches a URL wherever it is written in code — quoted or inside a
// multi-line template — but not one assembled at runtime (`"https://" + host`). That residue is
// accepted: the point is to stop an absolute URL being *typed* outside the registry, which is how
// the licence endpoint reached `content.js`.

import { GENERATED_PAGE_DIR, REGISTRY_DIRS } from "./scope";

const URL_LITERAL_RE = /https?:\/\/[^\s"'`)\\]+/g;
/** A wholly-comment line, and the trailing `//` of any line, is prose rather than shipped code. */
const COMMENT_LINE_RE = /^\s*(\/\/|\*|\/\*)/;
/** `(?<!:)` so a scheme's own `//` is never mistaken for the start of a comment. */
const TRAILING_COMMENT_RE = /(?<!:)\/\/.*$/;
const URL_EXEMPT_DIRS = [...REGISTRY_DIRS, GENERATED_PAGE_DIR];
/** XML namespaces are identifiers, not endpoints: every SVG-using page on the web carries them. */
const URL_EXEMPT = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml"]);

export interface UrlLiteralHit {
	file: string;
	line: number;
	url: string;
}

export function findUrlLiterals(files: Record<string, string>): UrlLiteralHit[] {
	const hits: UrlLiteralHit[] = [];
	for (const [file, text] of Object.entries(files)) {
		if (URL_EXEMPT_DIRS.some((d) => file.startsWith(d))) continue;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const raw = lines[i] ?? "";
			if (COMMENT_LINE_RE.test(raw)) continue;
			const line = raw.replace(TRAILING_COMMENT_RE, "");
			URL_LITERAL_RE.lastIndex = 0;
			let m = URL_LITERAL_RE.exec(line);
			while (m) {
				const url = m[0];
				if (!URL_EXEMPT.has(url)) hits.push({ file, line: i + 1, url });
				m = URL_LITERAL_RE.exec(line);
			}
		}
	}
	return hits;
}
