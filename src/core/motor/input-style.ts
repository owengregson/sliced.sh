/**
 * `auto` input mode's per-move click share (`Settings.execution.inputMode`; owner, 2026-09-11):
 * a piece nudged a square or two is clicked into place about a third of the time, a piece carried
 * across the board (Chebyshev distance ≥ `CLICK_MOVE.farSquares`) is nearly always dragged. Low on
 * time (2026-09-12) the click wins regardless of distance: a drag needs a steadier hand than a
 * scramble has. Pure; the executor draws against it from its per-move style stream. Premoves and
 * holds never consult it — they are drags by construction.
 */

import { distance } from "@core/chess/squares";
import { clamp } from "@core/util/clamp";
import type { Square } from "@typedefs/game";
import { CLICK_MOVE } from "./constants";

/** How far into the low-time ramp `myClockMs` is: 0 at or above `lowTimeRampMs`, 1 at or below `lowTimeMs`. */
export function lowTimeUrgency(myClockMs: number | undefined): number {
	if (myClockMs === undefined || myClockMs <= 0) return 0;
	const { lowTimeRampMs, lowTimeMs } = CLICK_MOVE;
	if (lowTimeRampMs <= lowTimeMs) return myClockMs <= lowTimeMs ? 1 : 0;
	return clamp((lowTimeRampMs - myClockMs) / (lowTimeRampMs - lowTimeMs), 0, 1);
}

/** Probability that `auto` commits `from → to` as a click-click rather than a drag. */
export function autoClickProbFor(from: Square, to: Square, myClockMs?: number): number {
	const base =
		distance(from, to).chebyshev >= CLICK_MOVE.farSquares
			? CLICK_MOVE.autoClickProbFar
			: CLICK_MOVE.autoClickProb;
	const urgency = lowTimeUrgency(myClockMs);
	return base + (CLICK_MOVE.lowTimeClickProb - base) * urgency;
}
