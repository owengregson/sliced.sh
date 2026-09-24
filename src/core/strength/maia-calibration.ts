/**
 * Reading the Maia strength calibration (`MAIA_CALIBRATION`): the chess.com time class of a game,
 * and the conditioning rating and sampling temperature for an advertised rating in it. Pure.
 */

import {
	MAIA_CALIBRATION,
	type MaiaCalibrationTable,
	type MaiaCalibrationTimeClass,
	MAIA_CALIBRATION_TIME_CLASS_RULE as RULE,
} from "@core/constants/maia-calibration";

export interface MaiaCalibrationPoint {
	/** The rating Maia is conditioned at before the context terms move it. */
	conditioningElo: number;
	/** Sampling temperature over Maia's legal-move distribution (`p^(1/T)`, renormalised). */
	temperature: number;
}

/** chess.com's time class for a clock of `baseMs` + `incrementMs`; unknown → the rule's fallback. */
export function maiaCalibrationTimeClass(
	baseMs: number | undefined,
	incrementMs: number | undefined
): MaiaCalibrationTimeClass {
	const base = baseMs !== undefined && Number.isFinite(baseMs) ? Math.max(0, baseMs) : 0;
	const inc =
		incrementMs !== undefined && Number.isFinite(incrementMs) ? Math.max(0, incrementMs) : 0;
	if (base <= 0 && inc <= 0) return RULE.fallback;
	const seconds = (base + RULE.incWeight * inc) / 1000;
	if (seconds < RULE.bulletMaxSec) return "bullet";
	if (seconds < RULE.blitzMaxSec) return "blitz";
	return "rapid";
}

/**
 * The calibration point for `targetElo` in `timeClass`: linear between knots; outside them the
 * conditioning keeps the edge knot's offset and the temperature stays at the edge value. A table
 * with no knots for the class is the identity.
 */
export function maiaCalibrationFor(
	targetElo: number,
	timeClass: MaiaCalibrationTimeClass,
	table: MaiaCalibrationTable = MAIA_CALIBRATION
): MaiaCalibrationPoint {
	const knots = table[timeClass];
	const first = knots[0];
	const last = knots[knots.length - 1];
	if (first === undefined || last === undefined || !Number.isFinite(targetElo))
		return { conditioningElo: targetElo, temperature: 1 };
	if (targetElo <= first[0])
		return { conditioningElo: targetElo + (first[1] - first[0]), temperature: first[2] };
	if (targetElo >= last[0])
		return { conditioningElo: targetElo + (last[1] - last[0]), temperature: last[2] };
	for (let i = 1; i < knots.length; i++) {
		const lo = knots[i - 1];
		const hi = knots[i];
		if (lo === undefined || hi === undefined || targetElo > hi[0]) continue;
		const t = hi[0] > lo[0] ? (targetElo - lo[0]) / (hi[0] - lo[0]) : 0;
		return {
			conditioningElo: lo[1] + t * (hi[1] - lo[1]),
			temperature: lo[2] + t * (hi[2] - lo[2]),
		};
	}
	return { conditioningElo: targetElo + (last[1] - last[0]), temperature: last[2] };
}
