/**
 * Committed-gesture mechanics (§9.3, §13.5): click timings, promotion picker, click-to-move and
 * the fast-touch gesture of an urgent plan.
 */

import type { MsRange } from "../types";

/**
 * Click mechanics (§9.3, §13.5). A *committed* move is always a drag, so there is no inter-click
 * gap here any more; what is left serves the preview selections (§9.3a) and the drag's own
 * pre-press pause.
 */
export const CLICK = {
	/** Real click drift: press and release within 2 px (integer ±1). */
	releaseDriftPx: 1,
	prePressPauseMs: [15, 60] as MsRange,
	preGrabPauseMs: [20, 70] as MsRange,
} as const;

export const PROMOTION_LOOK_DELAY_MS: MsRange = [150, 400];
/** Four picker choices can place the requested piece three square widths from the pawn. */
export const PROMOTION_PICKER_TRAVEL_SQUARES = 3;

/**
 * Click-to-move as a committed gesture (owner, 2026-09-11; `Settings.execution.inputMode`): click
 * the piece, carry the pointer over, click the square. `autoClickProb` is the per-move share of
 * clicks in `auto` mode; premoves and holds are drags regardless.
 */
export const CLICK_MOVE = {
	/**
	 * `auto`'s per-move click share by how far the piece travels (owner, 2026-09-11: "moves that
	 * move the piece FARTHER across the board (4+ squares) have higher chance to be a drag"): a
	 * short hop is a click a third of the time, a long carry (Chebyshev distance ≥ `farSquares`)
	 * only rarely — a human clicks to nudge a piece and drags to carry it across the board.
	 */
	autoClickProb: 0.34,
	autoClickProbFar: 0.12,
	farSquares: 4,
	/**
	 * Low on time a human clicks rather than drags (owner, 2026-09-12: "humans cant drag so
	 * precisely with little time left") — unless the move is a premove or a hold, which are drags
	 * by construction. The click share ramps linearly from the ordinary value at `lowTimeRampMs`
	 * left to `lowTimeClickProb` at `lowTimeMs` and below, whatever the distance.
	 */
	lowTimeRampMs: 30_000,
	lowTimeMs: 10_000,
	lowTimeClickProb: 0.75,
	/** Between letting go of the piece and setting off for the square. */
	interClickGapMs: [90, 320] as MsRange,
} as const;

/** A clock-race gesture spends its budget on the two useful legs, with no decorative delays. */
export const FAST_TOUCH = {
	/** The lowest an urgent plan may be fitted to when the deadline has already passed. */
	minBudgetMs: 60,
	maxBudgetMs: 300,
	/**
	 * The hard floor on the gesture itself: approach + press + carry + drop never total less than
	 * this, whatever the plan's window says (owner, 2026-09-11 — the executor could act faster than
	 * any hand). The physical floor of a human press-carry-drop over a couple of squares.
	 */
	gestureFloorMs: 150,
	sampleMs: 16,
	minLegFrac: 0.2,
	maxLegFrac: 0.8,
	promotionTravelMs: [24, 60] as MsRange,
} as const;
