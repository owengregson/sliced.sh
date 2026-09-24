/** The physical latency of a reply the hand anticipated (what the timing model plans with). */

import type { Rng } from "@core/rng";
import { ANTICIPATION as A } from "../constants/anticipation";

export interface AnticipatedExecution {
	/** Reaction to the expected reply (replaces the orientation latency). */
	orientationMs: number;
	/** In-square approach, pre-grab pause and grab (replaces the motor model's hover). */
	hoverS: number;
	/** The carry and its settle. */
	dragS: number;
	/** `orientationMs / 1000 + hoverS + dragS`, never below `ANTICIPATION.floorMs`. */
	totalS: number;
}

/**
 * The physical latency of an anticipated reply, `distSquares` being the move's Chebyshev
 * distance and `motorK` the persona's motor multiplier. Draw order is fixed: reaction, grasp,
 * carry. When the three draws sum to less than the human floor, the reaction absorbs the
 * difference, because a hand cannot carry faster, but a person can wait.
 */
export function anticipatedExecution(
	distSquares: number,
	motorK: number,
	rng: Rng
): AnticipatedExecution {
	const reactionMs = Math.max(
		A.reaction.minMs,
		A.reaction.medianMs * rng.logNormal(0, A.reaction.sigma)
	);
	const hoverS = Math.max(A.grasp.minS, A.grasp.medianS * rng.logNormal(0, A.grasp.sigma)) * motorK;
	const dragRaw =
		(A.drag.baseS +
			A.drag.logS * Math.log2(1 + Math.max(0, distSquares)) +
			rng.normal(0, A.drag.sdS)) *
		motorK;
	const dragS = Math.min(A.drag.maxS, Math.max(A.drag.minS, dragRaw));
	const motorS = hoverS + dragS;
	const orientationMs = Math.max(reactionMs, A.floorMs - motorS * 1000);
	return { orientationMs, hoverS, dragS, totalS: orientationMs / 1000 + motorS };
}
