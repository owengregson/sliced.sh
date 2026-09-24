// scripts/check-constants/rules.ts — the registry of source rules `checkConstants` runs, in
// order. Each rule finds its hits over the collected sources; the first rule with any hits
// prints them and fails the check (the emitted-program rule runs after all of them).

import { type Duplicate, findDuplicateLiterals } from "./duplicates";
import { type ForbiddenApiHit, findForbiddenPageApis } from "./page-apis";
import { findUrlLiterals, type UrlLiteralHit } from "./urls";

export interface SourceRule<Hit> {
	name: string;
	find(files: Record<string, string>): Hit[];
	/** One stderr line per hit. */
	format(hit: Hit): string;
	/** The error message, from the hit count. */
	summary(count: number): string;
}

/** Erase the hit type so rules of different hits share one list. */
function rule<Hit>(r: SourceRule<Hit>): SourceRule<unknown> {
	return r as SourceRule<unknown>;
}

export const SOURCE_RULES: readonly SourceRule<unknown>[] = [
	rule<Duplicate>({
		name: "duplicate-constants",
		find: findDuplicateLiterals,
		format: (d) => `duplicate constant "${d.literal}" in ${d.file} (defined in ${d.definedIn})`,
		summary: (n) => `${n} duplicated constant(s)`,
	}),
	rule<ForbiddenApiHit>({
		name: "forbidden-page-apis",
		find: findForbiddenPageApis,
		format: (h) => `forbidden page API "${h.api}" in ${h.file}:${h.line} (§13.3 rule 2)`,
		summary: (n) => `${n} forbidden page API use(s)`,
	}),
	rule<UrlLiteralHit>({
		name: "url-literals",
		find: findUrlLiterals,
		format: (u) =>
			`URL literal "${u.url}" in ${u.file}:${u.line} — register it in src/core/constants/ (C1)`,
		summary: (n) => `${n} unregistered URL literal(s)`,
	}),
];
