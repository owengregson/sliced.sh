/** Gate 3 — holds, or collapses? */

import { byRating } from "../../expected-points";
import type { BrilliantEvidence, BrilliantReason, BrilliantTuning } from "../types";

/**
 * The sacrifice keeps the mover standing (`minAfter`, no mate against) and stays near the best
 * move at the mover's rating — never beside a mate it declined or a faster one elsewhere.
 */
export function holdsGate(
	evidence: BrilliantEvidence,
	tuning: BrilliantTuning
): BrilliantReason | null {
	if (
		(evidence.playedMate ?? 0) < 0 ||
		(evidence.ratedPlayedPoints ?? evidence.playedPoints) < tuning.minAfter
	)
		return "unsound";
	const mateElsewhere = evidence.alternatives.some((alt) => (alt.mate ?? 0) > 0);
	const nearBestLoss =
		tuning.nearBestRatedLoss > 0 && evidence.ratedLoss !== undefined
			? evidence.ratedLoss
			: evidence.loss;
	const fasterMateElsewhere = evidence.alternatives.some(
		(alt) => (alt.mate ?? 0) > 0 && (alt.mate ?? 0) < (evidence.playedMate ?? 0)
	);
	if (
		nearBestLoss > byRating(tuning.maxLossNovice, tuning.maxLossExpert, evidence.moverRating) ||
		(mateElsewhere && (evidence.playedMate ?? 0) <= 0) ||
		(tuning.slowerMateNotBrilliant > 0 && fasterMateElsewhere)
	)
		return "not-near-best";
	return null;
}
