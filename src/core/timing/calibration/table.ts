/** Reading the think-time table: the time class of a clock, the knot interpolation and the shift. */

import {
	TIMING_CALIBRATION_LIMITS as LIMITS,
	TIMING_CALIBRATION,
	type TimingCalibrationSituation,
	type TimingCalibrationTable,
	type TimingCalibrationTimeClass,
} from "@core/constants/timing-calibration";
import { maiaCalibrationTimeClass } from "@core/strength/maia-calibration";
import { clamp } from "@core/util/clamp";

/** chess.com's time class of a clock (the rule the Maia calibration uses). */
export function calibrationTimeClass(baseSec: number, incSec: number): TimingCalibrationTimeClass {
	return maiaCalibrationTimeClass(baseSec * 1000, incSec * 1000);
}

/** Linear between knots, flat outside; `values` has one entry per knot. */
export function interpolateKnots(
	knots: readonly number[],
	values: readonly number[],
	rating: number
): number {
	const n = Math.min(knots.length, values.length);
	const first = values[0];
	if (n === 0 || first === undefined) return 0;
	if (!Number.isFinite(rating) || rating <= (knots[0] ?? 0)) return first;
	for (let i = 1; i < n; i++) {
		const k1 = knots[i] ?? 0;
		if (rating > k1) continue;
		const k0 = knots[i - 1] ?? k1;
		const v0 = values[i - 1] ?? 0;
		const v1 = values[i] ?? v0;
		return k1 > k0 ? v0 + ((rating - k0) / (k1 - k0)) * (v1 - v0) : v1;
	}
	return values[n - 1] ?? first;
}

/** The log shift of the sampled think for `situation` at `rating` (clamped). */
export function thinkShift(
	timeClass: TimingCalibrationTimeClass,
	rating: number,
	situation: TimingCalibrationSituation,
	table: TimingCalibrationTable = TIMING_CALIBRATION
): number {
	const c = table[timeClass];
	return clamp(
		interpolateKnots(c.knots, c.shift[situation], rating),
		LIMITS.shiftMin,
		LIMITS.shiftMax
	);
}
