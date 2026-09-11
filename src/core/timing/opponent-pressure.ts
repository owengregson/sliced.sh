import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";

export interface OpponentClockContext {
	ownClockMs: number;
	opponentClockMs: number;
	baseMs: number;
	incrementMs: number;
}

/** Urgency to deny a low-clock opponent extra thinking time, independent of the model. */
export function opponentClockPressure(input: OpponentClockContext): number {
	const { ownClockMs, opponentClockMs, baseMs, incrementMs } = input;
	if (
		![ownClockMs, opponentClockMs, baseMs, incrementMs].every(Number.isFinite) ||
		baseMs <= 0 ||
		ownClockMs <= 0 ||
		opponentClockMs <= 0 ||
		incrementMs < 0
	)
		return 0;
	const P = TIMING_CONSTANTS.opponentPressure;
	const threshold = clamp(baseMs * P.thresholdBaseFraction, P.thresholdMinMs, P.thresholdMaxMs);
	const effectiveOpponent = opponentClockMs + incrementMs * P.incrementHorizon;
	const urgency = clamp(1 - effectiveOpponent / threshold, 0, 1);
	// When our clock is even lower, our own survival policy takes precedence.
	const clockEdge = clamp(ownClockMs / Math.max(1, effectiveOpponent), P.ownClockRatioMin, 1);
	return urgency * clockEdge;
}
