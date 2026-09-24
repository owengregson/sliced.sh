/**
 * Anticipatory hover (2026-09-24, `docs/qa/anticipatory-hover-2026-09-24.md`). While the opponent
 * thinks, a strong player often has the hand resting on the piece that will answer the reply they
 * expect, most of all a recapture. When that reply lands they do not re-scan the board or travel
 * to the piece: they react, grab and carry. These are the numbers for that, both for the idle hand
 * (when it pre-positions) and for the timing model (the physical latency of the reply it made
 * possible).
 */

import type { MsRange, TimeControlClass } from "../types";

/** What the hand anticipates: our recapture of their capture, or the ponder's own answer. */
export type AnticipationKind = "recapture" | "ponder";

export const ANTICIPATION = {
	/**
	 * Per opponent turn, the chance that the idle hand pre-positions over our answering piece.
	 * A fast clock pre-positions most. A recapture is the reply a human is surest of. A
	 * long-think clock has time to look around instead. Untimed behaves like classical.
	 */
	engageProb: {
		recapture: { bullet: 0.85, blitz: 0.75, rapid: 0.45, classical: 0.25, untimed: 0.2 },
		ponder: { bullet: 0.5, blitz: 0.38, rapid: 0.18, classical: 0.08, untimed: 0.06 },
	} as Record<AnticipationKind, Record<TimeControlClass | "untimed", number>>,
	/** The hover point is sampled in the piece's square, this far off its centre (square fractions). */
	hoverSigmaFrac: 0.2,
	hoverInnerFrac: 0.8,
	/** A hover still counts while the hand rests inside the square grown by this fraction of a side. */
	hoverToleranceFrac: 0.15,
	/** Replaces the turn's initial rest when the hand will pre-position: it sets off sooner. */
	engageDelayMs: [300, 800] as MsRange,
	/** Dwell of one hover spell: the hand stays over the piece and re-plans (lines may change). */
	dwellMs: [1400, 3200] as MsRange,

	/**
	 * Reaction: registering the expected reply and releasing a prepared answer. No re-scan, so it
	 * is shorter than the ordinary orientation (median 380 ms). A cued choice reaction with the
	 * response already prepared is 180–260 ms. Log-normal, floored.
	 */
	reaction: { medianMs: 215, sigma: 0.25, minMs: 150 },
	/**
	 * The hand is already on the square: a short in-square approach (Fitts-floored, about 70–100
	 * ms once fitted), then the prepared pre-grab pause, the grab and its wobble (about 100 ms).
	 */
	grasp: { medianS: 0.17, sigma: 0.25, minS: 0.1 },
	/** Carrying the piece: Fitts on the distance, never shorter than the hand's minimum travel. */
	drag: { baseS: 0.13, logS: 0.06, sdS: 0.025, minS: 0.14, maxS: 0.5 },
	/**
	 * Hard human floor of the whole anticipated reply (reaction + grasp + carry). No hand makes an
	 * unpremoved move faster than this. Clock data put the fastest non-premove recaptures at
	 * 0.3 s.
	 */
	floorMs: 320,

	/** The prepared touch the executor runs for an anticipated plan: shorter pauses, no hesitation. */
	touch: {
		preGrabPauseMs: [10, 35] as MsRange,
		grabDelayScale: 0.6,
		releaseSettleMs: [15, 45] as MsRange,
	},
} as const;
