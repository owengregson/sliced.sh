/** Gate 2 — gift, or illusion? */

import { effectiveRating } from "../../expected-points";
import { regainedAtOnce, wonAtOnce } from "../illusion";
import { offersMovedPiece } from "../offers";
import type {
	BrilliantEvidence,
	BrilliantPlan,
	BrilliantReason,
	BrilliantTuning,
	SacrificeOffer,
} from "../types";

/**
 * A real offer, not unmade at the mover's rating by a standing threat or a checking recovery, not
 * won straight back along the engine's line, and made while a safer move was on the board.
 */
export function giftGate(
	plan: BrilliantPlan,
	evidence: BrilliantEvidence,
	tuning: BrilliantTuning
): BrilliantReason | null {
	if (plan.offers.length === 0) return "not-sacrifice";
	if (tuning.movedPieceOffersOnly > 0 && !plan.offers.some(offersMovedPiece)) return "not-sacrifice";
	const rating = effectiveRating(evidence.moverRating);
	const unmade = (offer: SacrificeOffer): boolean =>
		(offer.standing === true &&
			tuning.standingThreatMinRating > 0 &&
			rating >= tuning.standingThreatMinRating) ||
		(offer.checkRecovered === true &&
			tuning.checkRecoveryMinRating > 0 &&
			rating >= tuning.checkRecoveryMinRating);
	if (plan.offers.every(unmade)) return "illusion";
	if (
		evidence.playedPv &&
		(regainedAtOnce(plan, evidence.playedPv, tuning) ||
			wonAtOnce(plan, evidence.playedPv, evidence.moverRating, tuning))
	)
		return "illusion";
	if (!plan.safeAlternative) return "no-safe-alternative";
	return null;
}
