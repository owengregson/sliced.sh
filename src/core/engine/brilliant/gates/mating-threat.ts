/** Gate 4's quiet-mating-threat test: an ignored threat whose acceptance runs into mate. */

import { playUci } from "@core/chess/san";
import type { Chess } from "chess.js";
import { checkingMate } from "../recovery";
import type { BrilliantEvidence, BrilliantPlan, BrilliantTuning } from "../types";

/**
 * A quiet mating threat in an already won position need not be a sacrifice. Require a
 * winning non-sacrificing alternative AND prove that every already-attacked piece is
 * tactically untakeable. New/indirect offers, checks, and genuine moved-piece sacrifices
 * remain eligible, even when accepting them leads to mate.
 *
 * `board` is the position before the move; the test plays the move on it and leaves it played.
 */
export function isMatingThreat(
	plan: BrilliantPlan,
	evidence: BrilliantEvidence,
	tuning: BrilliantTuning,
	board: Chess | null,
	plainBest: number
): boolean {
	if (
		plainBest >= tuning.matingThreatAlternative &&
		(evidence.playedMate ?? 0) <= 0 &&
		tuning.ignoredThreatMatePlies > 0 &&
		plan.offers.every((offer) => offer.shape === "ignored-threat") &&
		board
	) {
		const move = playUci(board, plan.uci);
		if (move && !move.captured && !move.promotion && !/[+#]/.test(move.san)) {
			const budget = { nodes: 0 };
			const protectedByMate = plan.offers.every((offer) => {
				if (!playUci(board, offer.capture)) return false;
				try {
					return checkingMate(board, move.color, tuning.ignoredThreatMatePlies, tuning, budget) === true;
				} finally {
					board.undo();
				}
			});
			if (protectedByMate) return true;
		}
	}
	return false;
}
