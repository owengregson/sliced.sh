/**
 * From a head's sample to a budgeted duration. The learned distribution supplies relative
 * difficulty and variation; the actual game clock supplies scale — so the sample is rescaled by
 * the move budget over the head's mean, above its feasible lower endpoint, and a premove the
 * position did not earn becomes an instant reply.
 */
import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS as C } from "../constants";
import type { MoveBudget } from "../move-budget";
import type { Features, HeadSample, TimingMode } from "../types";

/** Orientation floor + motor floor: the physical minimum of every non-premove window. */
export const PHYSICAL_FLOOR_S = (C.orientation.minMs + C.motor.minMotorMs) / 1000;

/** The floor a bound total must respect: `minNormalMs` for normal/long moves, physical otherwise. */
export function floorFor(mode: TimingMode): number {
	return mode === "normal" || mode === "long"
		? Math.max(C.minNormalMs / 1000, PHYSICAL_FLOOR_S)
		: PHYSICAL_FLOOR_S;
}

export interface NormaliseInput {
	sample: HeadSample;
	/** The head's median and (floored) mean for the position, before any budgeting. */
	rawMedian: number;
	rawMean: number;
	budget: MoveBudget;
	/** The persona's per-game log speed (`s_game`). */
	sGame: number;
	moveTimeScale: number;
	untimed: boolean;
}

export interface NormalisedSample {
	tSec: number;
	mode: TimingMode;
	/** The compensation factor applied to the sample above its support. */
	comp: number;
	/** The move budget's target, persona-scaled. */
	target: number;
	/** The head's median, budgeted the same way (the pace residual's reference). */
	median: number;
	headSampleSec: number;
}

/** Rescale the head's sample to the move budget; appends its rationale to `why`. */
export function normaliseSample(input: NormaliseInput, why: string[]): NormalisedSample {
	const { sample, rawMedian, rawMean, budget, moveTimeScale } = input;
	let { tSec, mode } = sample;
	const headSampleSec = tSec;
	// Normalize by the mean, because a median does not budget a heavy tail.
	const target = budget.targetSec * Math.exp(input.sGame);
	// Scale the duration above its feasible lower endpoint. Multiplying the entire
	// learned duration and then clamping it created an atom at exactly 250 ms.
	const supportSec = sample.includesExecution ? floorFor(mode) : 0;
	const comp = input.untimed
		? moveTimeScale
		: Math.min(
				moveTimeScale,
				Math.max(0, target - supportSec) /
					Math.max(C.moveBudget.minimumShapeMeanS, rawMean - supportSec)
			);
	if (mode === "normal" || mode === "long")
		tSec = supportSec + Math.max(0, tSec - supportSec) * comp;
	else if (mode === "instant")
		tSec = supportSec + Math.max(0, tSec - supportSec) * Math.min(1, moveTimeScale);
	if (sample.includesExecution && comp === 0 && (mode === "normal" || mode === "long")) {
		// A recognition-weighted allocation can be smaller than a feasible cold reply.
		// Preserve sample order in a compact physical interval instead of emitting the same
		// 250 ms value on every such turn. Clock emergency policy may compress it further.
		mode = "instant";
		tSec = PHYSICAL_FLOOR_S * (1 + headSampleSec / (headSampleSec + rawMean));
		why.push("allocation below physical support: compact execution window");
	}
	const median = supportSec + Math.max(0, rawMedian - supportSec) * comp;
	why.push(
		`move budget ${target.toFixed(2)} s; effort ${budget.effort.toFixed(2)}, recognition ${budget.recognition.toFixed(2)}`
	);
	return { tSec, mode, comp, target, median, headSampleSec };
}

/**
 * A premove is only entered on a position that earned one (eligible, the reply we pondered, and
 * not a re-plan after an unexpected reply); otherwise the sample becomes an instant reply. A
 * premove pays the site's fixed submit penalty.
 */
export function guardPremove(
	s: { tSec: number; mode: TimingMode },
	f: Pick<Features, "premove_eligible" | "ponder_hit" | "opp_is_bot">,
	forbidPremove: boolean,
	why: string[]
): { tSec: number; mode: TimingMode } {
	let { tSec, mode } = s;
	if (mode === "premove" && (!f.premove_eligible || forbidPremove || !f.ponder_hit)) {
		mode = "instant";
		tSec = C.instant.minS + C.instant.rangeS * clamp(tSec / C.premove.maxS, 0, 1);
		why.push("no premove entered → instant");
	}
	if (mode === "premove") tSec += C.premove.penaltyS;
	if (f.opp_is_bot && mode !== "premove") why.push("bot opponent: mirror coefficient floored");
	return { tSec, mode };
}
