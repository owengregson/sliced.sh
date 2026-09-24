/**
 * Anticipatory hover (2026-09-24). This module has three pure parts:
 *
 * - `anticipateReply`: the reply this turn's hand may pre-position for, read from the ponder's
 *   top line (their expected move, then our answer). A recapture is the surest case.
 * - `anticipationEngageProb`: how often the idle hand actually does it. The executor draws once
 *   per opponent turn, and the timing replay harness uses the same table.
 * - `anticipatedExecution`: the physical latency of a reply the hand anticipated: a short
 *   reaction instead of an orientation re-scan, a grasp from the hover point instead of an
 *   approach, and the carry. The timing model plans with it when the hand really was hovering
 *   over the moving piece (`TimingContext.hoverSquare`).
 *
 * Nothing here dispatches input. The hover itself is free pointer movement, and it never
 * presses or selects.
 */

import type { Rng } from "@core/rng";
import { ANTICIPATION as A, type AnticipationKind } from "./constants/anticipation";
import type { OpponentExplorationCandidates, ReadStep } from "./opponent-candidates";
import type { TimeControlClass } from "./types";

export type { AnticipationKind } from "./constants/anticipation";

export interface AnticipatedReply {
	kind: AnticipationKind;
	/** The opponent's move we expect. */
	opponent: ReadStep;
	/** Our answer to it: the piece the hand rests on is `reply.from`. */
	reply: ReadStep;
}

/** The ponder's top line as an anticipation, or null when it does not carry our answer. */
export function anticipateReply(
	candidates: Pick<OpponentExplorationCandidates, "readings">
): AnticipatedReply | null {
	const top = candidates.readings?.find((reading) => reading.rank === 0);
	const opponent = top?.steps[0];
	const reply = top?.steps[1];
	if (!opponent || !reply || opponent.side !== "opponent" || reply.side !== "own") return null;
	return { kind: reply.to === opponent.to ? "recapture" : "ponder", opponent, reply };
}

/** Per-turn probability that the idle hand pre-positions over the answering piece. */
export function anticipationEngageProb(
	kind: AnticipationKind,
	tcClass: TimeControlClass | "untimed"
): number {
	return A.engageProb[kind][tcClass];
}

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

/** Whether `p` rests over `square`'s rect grown by the hover tolerance. */
export function withinHover(
	p: { x: number; y: number },
	rect: { left: number; top: number; width: number; height: number }
): boolean {
	const padX = rect.width * A.hoverToleranceFrac;
	const padY = rect.height * A.hoverToleranceFrac;
	return (
		p.x >= rect.left - padX &&
		p.x <= rect.left + rect.width + padX &&
		p.y >= rect.top - padY &&
		p.y <= rect.top + rect.height + padY
	);
}
