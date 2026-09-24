// scripts/check-constants.ts — C1 lint: no duplicated registry literals (§4.1 rule 4),
// plus the §13.3 rule 2 / §9 page-realm API ban.
//
// Scans `src/**/*.ts` (not `.d.ts`, not generated/) for
//   (a) string literals matching the namespaced prefixes (`sl::`, `sl:`, `sl-`, `__sl_`)
//       that are defined in a registry file and re-declared anywhere else,
//   (b) numeric literals annotated with a `// const: <Name>` marker outside a registry
//       file (the marker means "this number belongs in a registry"),
//   (c) under `src/content/**` and `src/page/**` only: any occurrence of a forbidden page
//       API (page storage, synthetic input events, speech, tab/window manipulation) —
//       comments included, so the words never appear there at all, and
//   (e) absolute URL literals outside the registry (C1 for URLs);
// and checks
//   (d) the emitted page programs (`src/page/generated/<name>.ts`, written by
//       `gen:pagescript` earlier in the pipeline): the `code` a MAIN-world script ships must
//       contain none of the §13.3 rule 5 product/engine words (Task 33).
//
// Each rule is its own module under `check-constants/`; `SOURCE_RULES` is their registry.
// This file is the public entry and the CLI.

import path from "node:path";
import { checkEmittedPrograms } from "./check-constants/page-programs";
import { SOURCE_RULES } from "./check-constants/rules";
import { collectSources } from "./check-constants/sources";
import { ROOT } from "./lib/paths";
import { failOnFindings } from "./lib/report";

export { type Duplicate, findDuplicateLiterals } from "./check-constants/duplicates";
export {
	FORBIDDEN_PAGE_APIS,
	type ForbiddenApiHit,
	findForbiddenPageApis,
} from "./check-constants/page-apis";
export {
	checkEmittedPrograms,
	FORBIDDEN_PAGE_SUBSTRINGS,
	type ForbiddenProgramHit,
	findForbiddenProgramSubstrings,
	findForbiddenSubstrings,
} from "./check-constants/page-programs";
export { SOURCE_RULES, type SourceRule } from "./check-constants/rules";
export { GENERATED_PAGE_DIR } from "./check-constants/scope";
export { findUrlLiterals, type UrlLiteralHit } from "./check-constants/urls";

export function checkConstants(root = "src"): void {
	const files = collectSources(path.resolve(ROOT, root));
	for (const rule of SOURCE_RULES) failOnFindings(rule.find(files), rule.format, rule.summary);
	checkEmittedPrograms();
}

if (import.meta.main) checkConstants();
