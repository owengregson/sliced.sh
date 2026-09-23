/** The ways a hand execution unwinds besides a plain abort, each carrying what its exit needs. */

import { EXECUTOR } from "@core/constants/cdp";
import type { Rect } from "@core/motor/types";

/** Thrown to unwind an execution the focus gate vetoed (§13.4). */
export class SkipError extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

/**
 * Thrown when the board's rect moved out from under a touch already in progress
 * (§9.5). Carries the rect the page reports *now*, which is what the escape
 * release is aimed with.
 */
export class BoardMovedError extends Error {
	constructor(readonly live: Rect) {
		super(EXECUTOR.reasons.boardMoved);
	}
}

/**
 * Thrown when a scramble hold was given up: the piece has already been carried back to its origin
 * square and released there, so nothing was submitted.
 */
export class HoldAbandonedError extends Error {
	constructor() {
		super(EXECUTOR.reasons.holdAbandoned);
	}
}
