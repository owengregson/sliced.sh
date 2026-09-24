// scripts/check-constants/page-apis.ts — rule (c): under `src/content/**` and `src/page/**`
// only, any occurrence of a forbidden page API (page storage, synthetic input events, speech,
// tab/window manipulation) — comments included, so the words never appear there at all.

import { PAGE_REALM_DIRS } from "./scope";

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
