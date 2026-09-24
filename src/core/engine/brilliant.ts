/**
 * Brilliant moves — a sound piece sacrifice the player chose (`BRILLIANT`, `@core/constants/review`).
 *
 * Two halves. `planBrilliant` is pure chess and needs no engine: it finds every piece the move
 * leaves to be taken for a real concession (the offers) and whether the player had a safe
 * alternative. `evaluateBrilliant` then applies the engine gates to expected points the move
 * classifier has already computed, so a verdict never searches anything on its own.
 *
 * The parts live in `brilliant/`: material accounting (`material.ts`), the tactical recovery
 * proofs (`recovery.ts`), offer detection (`offers.ts`), the plan (`plan.ts`), the engine-line
 * illusion tests (`illusion.ts`) and one module per gate (`gates/`). This file stays the public
 * entry and owns only the gate order.
 */

import { loadPosition } from "@core/chess/fen";
import { BRILLIANT } from "@core/constants/review";
import { chosenGate } from "./brilliant/gates/chosen";
import { evidenceGate } from "./brilliant/gates/evidence";
import { giftGate } from "./brilliant/gates/gift";
import { holdsGate } from "./brilliant/gates/holds";
import { victoryLapGate } from "./brilliant/gates/victory-lap";
import { planBrilliant } from "./brilliant/plan";
import type {
	BrilliantEvidence,
	BrilliantPlan,
	BrilliantPlanInput,
	BrilliantReason,
	BrilliantTuning,
	BrilliantVerdict,
} from "./brilliant/types";

export { staticExchange } from "./brilliant/material";
export { planBrilliant } from "./brilliant/plan";
export type {
	BrilliantAlternative,
	BrilliantEvidence,
	BrilliantPlan,
	BrilliantPlanInput,
	BrilliantReason,
	BrilliantTuning,
	BrilliantVerdict,
	SacrificeOffer,
	SacrificeShape,
} from "./brilliant/types";

/** The four gates, over expected points the classifier already holds. */
export function evaluateBrilliant(
	plan: BrilliantPlan,
	evidence: BrilliantEvidence,
	tuning: BrilliantTuning = BRILLIANT
): BrilliantVerdict {
	const reason = firstFailedGate(plan, evidence, tuning) ?? "sound-sacrifice";
	return { brilliant: reason === "sound-sacrifice", reason, offers: plan.offers };
}

/** The gates in order; the first to fail names the verdict. */
function firstFailedGate(
	plan: BrilliantPlan,
	evidence: BrilliantEvidence,
	tuning: BrilliantTuning
): BrilliantReason | null {
	// 1. Chosen, or forced? 2. Gift, or illusion?
	const early = chosenGate(plan) ?? giftGate(plan, evidence, tuning);
	if (early) return early;
	const board = loadPosition(plan.fen);
	return (
		evidenceGate(plan, evidence, board) ??
		// 3. Holds, or collapses?
		holdsGate(evidence, tuning) ??
		// 4. Fight, or victory lap?
		victoryLapGate(plan, evidence, tuning, board)
	);
}

export function classifyBrilliant(
	input: BrilliantPlanInput & BrilliantEvidence,
	tuning: BrilliantTuning = BRILLIANT
): BrilliantVerdict {
	const plan = planBrilliant(input, tuning);
	return plan
		? evaluateBrilliant(plan, input, tuning)
		: { brilliant: false, reason: "illegal", offers: [] };
}
