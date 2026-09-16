/**
 * Which Maia-3 size answers for a target Elo, and whether Maia selects at all for it.
 */

import { MAIA, MAIA_INPUT, type MaiaSize } from "@core/constants/maia";
import { clamp } from "@core/util/clamp";

/**
 * The product's Maia-led interval, independent of form or temporary penalties. Above it Maia is
 * not queried at all: there is no in-between prior band since 2026-09-15 (`MAIA.eloMax`).
 */
export function usesMaia(targetElo: number): boolean {
	return Number.isFinite(targetElo) && targetElo <= MAIA.eloMax;
}

/**
 * Canonical self-rating input: rounding after the clamp changes it by at most 0.5 Elo
 * and prevents insignificant clock drift from invalidating a reusable policy answer.
 * Opponent ratings retain their existing validation.
 */
export function maiaConditioningElo(elo: number): number {
	return Math.round(
		clamp(
			Number.isFinite(elo) ? elo : MAIA.context.eloFloor,
			MAIA_INPUT.eloMin,
			MAIA.conditioningEloMax
		)
	);
}

export function upperVerificationProgress(elo: number): number {
	const { fromElo, fullElo } = MAIA.upperVerification;
	return Number.isFinite(elo) ? clamp((elo - fromElo) / (fullElo - fromElo), 0, 1) : 0;
}

/** Infinite at the unchanged boundary, approaching the upper range's finite loss limit smoothly. */
export function maiaMaxCpLoss(elo: number): number {
	const progress = upperVerificationProgress(elo);
	return progress > 0 ? MAIA.upperVerification.maxCpLoss / progress : Number.POSITIVE_INFINITY;
}

/** One packaged size serves every supported rating. */
export function maiaSizeFor(targetElo: number): MaiaSize {
	for (const band of MAIA.sizeBands) if (targetElo <= band.maxElo) return band.size;
	const last = MAIA.sizeBands[MAIA.sizeBands.length - 1];
	return last?.size ?? MAIA.defaultSize;
}
