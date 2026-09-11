import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";

export interface OpponentClockContext {
	ownClockMs: number;
	opponentClockMs: number;
	baseMs: number;
	incrementMs: number;
}

export interface ClockRacePolicy {
	urgency: number;
	opponentUrgency: number;
	ownUrgency: number;
	minMoveMs: number;
	maxMoveMs: number;
	maxSearchMs: number;
}

/** Shared post-model limits for clock races and timed lone-king positions. */
export function clockRacePolicy(
	input: OpponentClockContext & { loneKing?: boolean }
): ClockRacePolicy | null {
	const { ownClockMs, opponentClockMs, baseMs, incrementMs } = input;
	if (
		![ownClockMs, opponentClockMs, baseMs, incrementMs].every(Number.isFinite) ||
		(baseMs <= 0 && incrementMs <= 0) ||
		ownClockMs <= 0 ||
		incrementMs < 0
	)
		return null;
	const C = TIMING_CONSTANTS.clockRace;
	const opponentUrgency =
		opponentClockMs > 0 && opponentClockMs < C.opponentThresholdMs
			? (C.opponentBaseUrgency +
					(1 - C.opponentBaseUrgency) * (1 - opponentClockMs / C.opponentThresholdMs)) *
				(C.opponentThresholdMs / (C.opponentThresholdMs + incrementMs * C.incrementHorizon))
			: 0;
	const ownUrgency =
		ownClockMs < C.ownThresholdMs
			? C.ownBaseUrgency + (1 - C.ownBaseUrgency) * (1 - ownClockMs / C.ownThresholdMs)
			: 0;
	const urgency = Math.max(opponentUrgency, ownUrgency, input.loneKing ? 1 : 0);
	if (urgency === 0) return null;
	const interpolate = (range: readonly [number, number]): number =>
		range[0] + (range[1] - range[0]) * urgency;
	const clockCap = Math.max(C.minimumWindowMs, ownClockMs * C.remainingClockFraction);
	const maxMoveMs = Math.min(interpolate(C.moveMaxMs), clockCap);
	return {
		urgency,
		opponentUrgency,
		ownUrgency,
		minMoveMs: Math.min(interpolate(C.moveMinMs), maxMoveMs),
		maxMoveMs,
		maxSearchMs: Math.round(Math.min(interpolate(C.searchMaxMs), clockCap)),
	};
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
