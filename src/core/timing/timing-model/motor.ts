/** The hand's share of a plan: the §3a.6 motor model plus the occasional hesitation fake-out. */
import { parseUci } from "@core/chess/san";
import type { Rng } from "@core/rng";
import { TIMING_CONSTANTS as C } from "../constants";
import { uniform } from "../distributions";
import { type MotorTimes, motorModel } from "../move-window";
import type { Features, Persona, TimingContext, TimingMode, TimingPlan } from "../types";

export type PlannedMotor = MotorTimes & { fakeout?: TimingPlan["fakeout"] };

/**
 * Motor times for the move, and on a normal move with clock to spare a fake-out: a hold over
 * another piece (the runner-up's, when there is a reasonable one) before the real move.
 */
export function planMotor(
	f: Features,
	ctx: TimingContext,
	mode: TimingMode,
	persona: Persona,
	rng: Rng
): PlannedMotor {
	const autoQueen = ctx.autoQueen && ctx.chosenMove.endsWith("q");
	const motor = motorModel(f, { ...ctx, autoQueen }, persona, rng);
	if (mode !== "normal" || (f.tc !== "untimed" && f.clock_s <= C.fakeout.minClockS)) return motor;
	if (rng.next() >= C.fakeout.pBase + C.fakeout.pElo * (1 - f.elo_z)) return motor;
	const alt =
		f.n_reasonable >= 2 ? ctx.lines.find((line) => line.pvUci[0] !== ctx.chosenMove) : undefined;
	const piece = (alt && parseUci(alt.pvUci[0] ?? "")?.from) || f.from;
	const holdMs = uniform(rng, C.fakeout.holdMs[0], C.fakeout.holdMs[1]);
	const gapMs = uniform(rng, C.fakeout.gapMs[0], C.fakeout.gapMs[1]);
	return {
		...motor,
		totalS: motor.totalS + (holdMs + gapMs) / 1000,
		fakeout: { piece, holdMs, gapMs },
	};
}
