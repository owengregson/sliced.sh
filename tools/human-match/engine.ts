/**
 * tools/human-match/engine.ts — the referee engine at its historical path. The runner lives in
 * `tools/lib/engine/referee.ts` (the search contract in `tools/lib/engine/types.ts`, the repository
 * root in `tools/lib/paths.ts`); importing this file still installs the `define` globals and the
 * console log sink first. Nothing here runs in the extension.
 */

import "../lib/defines";

export { createRefereeEngine } from "../lib/engine/referee";
export type {
	CapturedCycle,
	RefereeEngine,
	RefereeOptions,
	SearchFrame,
	SearchSpec,
} from "../lib/engine/types";
export { ROOT } from "../lib/paths";
