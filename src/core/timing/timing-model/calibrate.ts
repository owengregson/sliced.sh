/**
 * The think-time calibration stage (`TIMING_CALIBRATION`, fitted by
 * `tools/timing-calibration/fit.ts`): between the budget normalisation and the clock policies, the
 * sampled think of a normal, long or instant move is shifted on the log scale by the table's value
 * for the move's situation at the target rating in the game's chess.com time class. Only the part
 * above the sample's physical support moves (the same rule as the normalisation), so the shift
 * never creates an atom at the floor; the clock policies, caps and emergencies bound the result
 * exactly as before. A premove is never touched here: how often one is armed is the session's
 * (`calibratedPremoveProbability`).
 */

import { loadPosition } from "@core/chess/fen";
import {
	TIMING_CALIBRATION_LIMITS,
	TIMING_CALIBRATION_SITUATIONS,
	type TimingCalibrationTable,
} from "@core/constants/timing-calibration";
import { clamp } from "@core/util/clamp";
import {
	calibrationSituation,
	calibrationTimeClass,
	isObviousRecapture,
	thinkShift,
} from "../calibration";
import type { Features, TimingContext } from "../types";
import { floorFor, type NormalisedSample } from "./normalise";

export interface CalibratedSample {
	sample: NormalisedSample;
	shift: number;
	situationIndex: number;
	/** The table's `budgetPower` for the game's time class (1 when not calibrated). */
	budgetPower: number;
}

/** The situation of the chosen move (`calibrationSituation`) from the context and features. */
export function situationOf(ctx: TimingContext, f: Features): number {
	const last = ctx.moves.length ? ctx.moves[ctx.moves.length - 1] : undefined;
	const situation = calibrationSituation({
		isOnlyLegal: f.is_only_legal === 1,
		inBook: f.in_book === 1,
		obviousRecapture:
			f.is_recapture === 1 && isObviousRecapture(ctx.priorFen, last, ctx.fen, ctx.chosenMove),
		inCheck: loadPosition(ctx.fen)?.inCheck() ?? false,
	});
	return TIMING_CALIBRATION_SITUATIONS.indexOf(situation);
}

export function calibrateSample(
	normalised: NormalisedSample,
	input: {
		ctx: TimingContext;
		f: Features;
		includesExecution: boolean;
		table: TimingCalibrationTable;
		/** The settings' duration multiplier (the budget's `comp` never exceeds it). */
		moveTimeScale: number;
	},
	why: string[]
): CalibratedSample {
	const { ctx, f, includesExecution, table } = input;
	const situationIndex = situationOf(ctx, f);
	const situation = TIMING_CALIBRATION_SITUATIONS[situationIndex];
	const mode = normalised.mode;
	// The table was fitted on the learned head's clock-labelled samples (`includesExecution`); the
	// parametric fallback's samples are budget-shaped by design and are left as they are.
	if (
		!includesExecution ||
		f.tc === "untimed" ||
		situation === undefined ||
		!(mode === "normal" || mode === "long" || mode === "instant")
	)
		return { sample: normalised, shift: 0, situationIndex, budgetPower: 1 };
	const timeClass = calibrationTimeClass(ctx.baseSec, ctx.incSec);
	const L = TIMING_CALIBRATION_LIMITS;
	const tableShift = thinkShift(timeClass, ctx.targetElo, situation, table);
	// Thinking longer than the budget is faded out as the own clock runs down.
	const clockWeight = clamp(
		(f.pressure - L.shiftClockZero[timeClass]) /
			(L.shiftClockFull[timeClass] - L.shiftClockZero[timeClass]),
		0,
		1
	);
	const shift = tableShift > 0 ? tableShift * clockWeight : tableShift;
	const power = clamp(table[timeClass].budgetPower, L.budgetPowerMin, L.budgetPowerMax);
	const support = includesExecution ? floorFor(mode) : 0;
	let above = Math.max(0, normalised.tSec - support);
	// Undo part of the budget's compression (normal and long samples only; an instant one was
	// never scaled by it). `comp` 0 is the compact-execution path, which stays as it is.
	const scale = input.moveTimeScale;
	if (power !== 1 && (mode === "normal" || mode === "long") && normalised.comp > 0 && scale > 0) {
		const kept = scale * Math.min(1, normalised.comp / scale) ** power;
		above = Math.max(0, normalised.headSampleSec - support) * kept;
	}
	if (shift === 0 && power === 1)
		return { sample: normalised, shift, situationIndex, budgetPower: power };
	const tSec = support + above * Math.exp(shift);
	why.push(
		`calibration: ${situation} ×${Math.exp(shift).toFixed(2)}${power === 1 ? "" : `, budget^${power}`}`
	);
	return { sample: { ...normalised, tSec }, shift, situationIndex, budgetPower: power };
}
