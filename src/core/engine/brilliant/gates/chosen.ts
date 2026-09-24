/** Gate 1 — chosen, or forced? */

import type { BrilliantPlan, BrilliantReason } from "../types";

/** Book and forced moves were never a choice; an unproved exchange is no evidence either way. */
export function chosenGate(plan: BrilliantPlan): BrilliantReason | null {
	if (plan.inBook === true) return "book";
	if (plan.legalMoves < 2) return "forced";
	if (!plan.materialComplete) return "insufficient-evidence";
	return null;
}
