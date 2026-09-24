/** The table's premove attempt rates: per kind, per rating, scaled by the persona's propensity. */

import { PREMOVE } from "@core/constants/books";
import {
	TIMING_CALIBRATION_LIMITS as LIMITS,
	TIMING_CALIBRATION,
	type TimingCalibrationTable,
	type TimingCalibrationTimeClass,
} from "@core/constants/timing-calibration";
import { clamp } from "@core/util/clamp";
import { interpolateKnots } from "./table";

export type PremoveKind = "recapture" | "other";

/**
 * The calibrated premove probability for `kind` at `rating`, scaled by the persona's own premove
 * propensity `personaP` (0.5 = the population mean); `null` when the table keeps the propensity.
 */
export function calibratedPremoveProbability(
	timeClass: TimingCalibrationTimeClass,
	rating: number,
	kind: PremoveKind,
	personaP: number,
	table: TimingCalibrationTable = TIMING_CALIBRATION
): number | null {
	const c = table[timeClass];
	const values = c.premove[kind];
	if (values === null) return null;
	const base = interpolateKnots(c.knots, values, rating);
	const persona = 1 + LIMITS.premovePersona * ((clamp(personaP, 0, 1) - 0.5) / 0.5);
	return clamp(base * persona, LIMITS.premoveMin, LIMITS.premoveMax);
}

/**
 * The premove attempt probabilities the session hands `premoveCandidate` (`PremoveContext.propensity`):
 * the calibrated recapture (`trade`) and other (`ordinary`) values for the rating in the time class,
 * persona-scaled; a kind the table leaves `null` is omitted, so the strength propensity answers.
 */
export function premovePropensity(
	timeClass: TimingCalibrationTimeClass,
	rating: number,
	personaP: number,
	table: TimingCalibrationTable = TIMING_CALIBRATION
): { trade?: number; ordinary?: number; tradeReplyMinProb?: number } {
	const trade = calibratedPremoveProbability(timeClass, rating, "recapture", personaP, table);
	const ordinary = calibratedPremoveProbability(timeClass, rating, "other", personaP, table);
	return {
		// A calibrated trade propensity comes with the trade's own prediction gate
		// (`PREMOVE.tradeReplyMinProb`): the two were fitted together.
		...(trade === null ? {} : { trade, tradeReplyMinProb: PREMOVE.tradeReplyMinProb }),
		...(ordinary === null ? {} : { ordinary }),
	};
}
