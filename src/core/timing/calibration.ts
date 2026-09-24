/**
 * Reading the think-time calibration (`TIMING_CALIBRATION`, fitted by `tools/timing-calibration`):
 * the situation of a move, the log shift of its sampled think and the premove propensities for a
 * rating in a chess.com time class. Pure; the only chess logic is delegated to the chess helpers.
 *
 * The parts live under `./calibration/`: `table` (time class, knot interpolation, the think
 * shift), `premove` (the calibrated attempt rates) and `situation` (the situation of a move and
 * the obvious-recapture rule). The stage that applies the shift is `timing-model/calibrate.ts`.
 */

import type {
	TimingCalibrationSituation,
	TimingCalibrationTable,
	TimingCalibrationTimeClass,
} from "@core/constants/timing-calibration";

export {
	calibratedPremoveProbability,
	type PremoveKind,
	premovePropensity,
} from "./calibration/premove";
export {
	calibrationSituation,
	isObviousRecapture,
	obviousRecaptureAvailable,
	type SituationInput,
} from "./calibration/situation";
export { calibrationTimeClass, interpolateKnots, thinkShift } from "./calibration/table";
export type { TimingCalibrationSituation, TimingCalibrationTable, TimingCalibrationTimeClass };
