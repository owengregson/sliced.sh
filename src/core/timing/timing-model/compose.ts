/**
 * Compose the move's total think from the budgeted sample: the clock-race policy, the hand's
 * physical time (orientation + motor), the hard cap, opponent clock pressure and our own
 * emergency. Every random draw happens here in one fixed order — motor, orientation, cap
 * jitter, race window — so the stream a plan consumes never depends on which policies bind.
 */
import { isLoneKing } from "@core/chess/material";
import { anticipatedExecution } from "@core/motor/anticipation";
import { ANTICIPATION } from "@core/motor/constants/anticipation";
import type { Rng } from "@core/rng";
import { TIMING_CONSTANTS as C } from "../constants";
import { uniform } from "../distributions";
import type { MoveBudget } from "../move-budget";
import { type ClockRacePolicy, clockRacePolicy, opponentClockPressure } from "../opponent-pressure";
import { sampleOrientationMs } from "../orientation";
import { boundByCap } from "../pressure";
import type { Features, HeadSample, Persona, TimingContext, TimingMode } from "../types";
import { type PlannedMotor, planMotor } from "./motor";
import { floorFor } from "./normalise";

export interface ComposeInput {
	f: Features;
	ctx: TimingContext;
	mode: TimingMode;
	tSec: number;
	sample: Pick<HeadSample, "includesExecution" | "opponentClockConditioned">;
	budget: MoveBudget;
	persona: Persona;
	rng: Rng;
}

export interface ComposedThink {
	/** `instant` under a clock race, else the input mode. */
	mode: TimingMode;
	motor: PlannedMotor;
	orientationMs: number;
	/** Orientation + motor, in seconds. */
	physicalS: number;
	capSec: number;
	totalS: number;
	emergency: boolean;
	/** Our own emergency or a lone king (opponent-only pressure is not a race here). */
	race: ClockRacePolicy | null;
	loneKing: boolean;
	opponentPressure: number;
	/** The hand rested on the answering piece and makes a prepared reply (`anticipate`). */
	anticipated: boolean;
}

/**
 * The hand was resting on the piece that answers (an engaged anticipatory hover, `hoverSquare`)
 * and this move is that piece's expected answer — the pondered reply or a recapture: a quick
 * sampled think is then a reaction, a grasp and a carry (`anticipatedExecution`), not an
 * orientation re-scan and an approach. A premove, a long think or a clock race is not.
 */
function anticipates(f: Features, ctx: TimingContext, mode: TimingMode): boolean {
	return (
		(mode === "normal" || mode === "instant") &&
		ctx.hoverSquare !== undefined &&
		ctx.hoverSquare !== null &&
		ctx.hoverSquare === f.from &&
		(f.ponder_hit === 1 || f.is_recapture === 1)
	);
}

/** Bound the sampled think by the clock; appends its rationale to `why`. */
export function composeThink(input: ComposeInput, why: string[]): ComposedThink {
	const { f, ctx, tSec, sample, budget, rng } = input;
	let mode = input.mode;
	const loneKing = isLoneKing(ctx.fen, ctx.myColor);
	const clockInput = {
		ownClockMs: ctx.myClockMs,
		opponentClockMs: ctx.oppClockMs,
		baseMs: ctx.baseSec * 1000,
		incrementMs: ctx.incSec * 1000,
	};
	const clockPolicy = clockRacePolicy({ ...clockInput, loneKing });
	// The shared policy still bounds search and strength under opponent pressure.
	// Only our own emergency (or a lone king) imposes a forced execution window;
	// opponent-only pressure retains the clock-conditioned sample (or gradual fallback).
	const race = clockPolicy?.opponentOnly ? null : clockPolicy;
	if (race) mode = "instant";
	let motor = planMotor(f, ctx, mode, input.persona, rng);
	let orientationMs = race || mode === "premove" ? 0 : sampleOrientationMs(f, rng);
	let physicalS = orientationMs / 1000 + motor.totalS;
	// Drawn after the ordinary motor and orientation, so an un-anticipated plan's stream is unchanged.
	const prepared =
		!race && anticipates(f, ctx, mode)
			? anticipatedExecution(f.dist, input.persona.motor_k, rng)
			: null;
	const anticipated = prepared !== null && tSec <= C.anticipated.maxThinkFactor * prepared.totalS;
	if (prepared && anticipated) {
		mode = "instant";
		const handS = prepared.hoverS + prepared.dragS + motor.promoS;
		motor = { hoverS: prepared.hoverS, dragS: prepared.dragS, promoS: motor.promoS, totalS: handS };
		orientationMs = prepared.orientationMs;
		physicalS = orientationMs / 1000 + handS;
		why.push(
			`anticipated reply: hand on ${f.from}, prepared touch ${(physicalS * 1000).toFixed(0)} ms`
		);
	}
	const clockEmergency = f.tc !== "untimed" && ctx.myClockMs < C.replan.emergencyClockMs;
	// A mean-constrained learned distribution may spend several allocations on one rare
	// decision. Capping it again at the routine allocation erased its affordable long tail.
	const capSec = Math.min(
		sample.includesExecution ? budget.distributionCapSec : budget.capSec,
		Math.max(physicalS, budget.recognitionCapSec)
	);
	const value = anticipated
		? Math.max(tSec, physicalS)
		: mode === "premove"
			? motor.totalS + tSec
			: sample.includesExecution
				? tSec
				: mode === "instant"
					? physicalS + tSec
					: Math.max(tSec, physicalS);
	const lowS = anticipated ? ANTICIPATION.floorMs / 1000 : floorFor(mode);
	const bounded = boundByCap(value, capSec, lowS, clockEmergency, rng);
	let totalS = bounded.totalSec;
	let emergency = bounded.emergency;
	if (bounded.bound) why.push(`cap ${capSec.toFixed(2)} s binds (lo ${bounded.lo.toFixed(2)})`);

	const opponentPressure = opponentClockPressure(clockInput);
	if (opponentPressure > 0 && mode !== "premove") {
		if (sample.opponentClockConditioned) {
			why.push("opponent clock pressure: included in learned sample");
		} else {
			const factor = 1 - C.opponentPressure.maxThinkReduction * opponentPressure;
			const floor = emergency ? C.motor.minMotorMs / 1000 : Math.max(floorFor(mode), physicalS);
			totalS = Math.min(totalS, Math.max(floor, totalS * factor));
			why.push(`opponent clock pressure: think ×${factor.toFixed(2)}`);
		}
	}
	if (race) {
		totalS = Math.min(totalS, uniform(rng, race.minMoveMs, race.maxMoveMs) / 1000);
		emergency = true;
		why.push(loneKing ? "lone king: fast execution" : "own clock emergency: fast execution");
	}
	if (emergency) why.push("emergency regime: no floors, minimal motor");
	return {
		mode,
		motor,
		orientationMs,
		physicalS,
		capSec,
		totalS,
		emergency,
		race,
		loneKing,
		opponentPressure,
		anticipated,
	};
}
