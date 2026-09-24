/** When the head's position-conditioned inference is skipped: our own clock race or a lone king. */
import { isLoneKing } from "@core/chess/material";
import { clockRacePolicy } from "../opponent-pressure";
import type { TimingContext } from "../types";

/**
 * Whether `prepare`/`prepareMove` skip the head's inference for `ctx`: only under our own clock
 * race (or a lone king), whose instant plan never reads the head.
 */
export function skipsInference(ctx: TimingContext): boolean {
	const race = clockRacePolicy({
		ownClockMs: ctx.myClockMs,
		opponentClockMs: ctx.oppClockMs,
		baseMs: ctx.baseSec * 1000,
		incrementMs: ctx.incSec * 1000,
		loneKing: isLoneKing(ctx.fen, ctx.myColor),
	});
	// An opponent's short clock is a reason to play briskly, not to discard
	// position-conditioned thinking while we can still afford it.
	return race !== null && !race.opponentOnly;
}
