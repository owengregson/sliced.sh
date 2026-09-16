/**
 * Local rating-scaled logistic approximation of expected points, not Chess.com's unpublished
 * fitted model and not Stockfish's self-play WDL probability.
 */

import { EXPECTED_POINTS as M } from "@core/constants/review";
import type { Eval } from "@typedefs/engine";

/** The rating a verdict is judged at: the mover's when known, else the model's reference. */
export function effectiveRating(rating: number | undefined): number {
	return rating !== undefined && Number.isFinite(rating) ? rating : M.referenceRating;
}

/** 0 at or below `noviceRating`, 1 at or above `expertRating`, linear between. */
export function ratingProgress(rating: number | undefined): number {
	const at = (effectiveRating(rating) - M.noviceRating) / (M.expertRating - M.noviceRating);
	return Math.max(0, Math.min(1, at));
}

/** A rating-dependent threshold: `novice` for newer players, `expert` for strong ones. */
export function byRating(novice: number, expert: number, rating: number | undefined): number {
	return novice + (expert - novice) * ratingProgress(rating);
}

/** Expected points for the score's owner, in [0, 1]; `null` for an unusable score. */
export function expectedPoints(score: Eval, moverRating?: number): number | null {
	if (score.mate !== undefined) {
		if (!Number.isInteger(score.mate) || score.mate === 0) return null;
		return score.mate > 0 ? 1 : 0;
	}
	if (score.cp === undefined || !Number.isFinite(score.cp)) return null;
	const scale = Math.max(
		M.minSlopeScale,
		Math.min(
			M.maxSlopeScale,
			1 + (effectiveRating(moverRating) - M.referenceRating) / M.ratingScaleSpan
		)
	);
	return 1 / (1 + Math.exp(-M.referenceSlope * scale * score.cp));
}

/** The same score from the other side's point of view. */
export function negateScore(score: Eval): Eval {
	if (score.mate !== undefined) return { mate: -score.mate };
	return score.cp === undefined ? {} : { cp: -score.cp };
}
