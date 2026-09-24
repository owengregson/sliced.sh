/** The engine evidence must be well-formed before gates 3 and 4 read it. */

import type { Chess } from "chess.js";
import { uciOf } from "../material";
import type { BrilliantEvidence, BrilliantPlan, BrilliantReason } from "../types";

/**
 * Expected points are probabilities, a mate is a non-zero integer, and every alternative is
 * another legal move of `board` (the position before the move).
 */
export function evidenceGate(
	plan: BrilliantPlan,
	evidence: BrilliantEvidence,
	board: Chess | null
): BrilliantReason | null {
	const probability = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;
	const legal = new Set(board?.moves({ verbose: true }).map(uciOf));
	if (
		!probability(evidence.playedPoints) ||
		(evidence.ratedPlayedPoints !== undefined && !probability(evidence.ratedPlayedPoints)) ||
		!probability(evidence.loss) ||
		(evidence.ratedLoss !== undefined && !probability(evidence.ratedLoss)) ||
		(evidence.playedMate !== undefined &&
			(!Number.isInteger(evidence.playedMate) || evidence.playedMate === 0)) ||
		evidence.alternatives.length === 0 ||
		evidence.alternatives.some(
			(alt) => !probability(alt.points) || alt.uci === plan.uci || !legal.has(alt.uci)
		)
	)
		return "insufficient-evidence";
	return null;
}
