/**
 * Which Maia-3 size answers for a target Elo, and whether Maia selects at all for it.
 */

import { LIMITS } from "@core/constants/limits";
import { MAIA, type MaiaSize } from "@core/constants/maia";

/**
 * Maia is the selector strictly below `MAIA.eloMax` (the *target*, not the form-adjusted E).
 * The Elo alone decides (the owner's ruling, 2026-09-11): there is no user-facing switch.
 */
export function usesMaia(targetElo: number): boolean {
	return targetElo < MAIA.eloMax;
}

/**
 * H15 (2026-09-13): from `MAIA.eloMax` up to (not including) `LIMITS.eloMax`, Maia-79M is queried
 * as a *prior* for the engine's tie-break, not as the selector. `usesMaia` stays false there.
 */
export function usesMaiaPrior(targetElo: number): boolean {
	return targetElo >= MAIA.eloMax && targetElo < LIMITS.eloMax;
}

/**
 * Nearest band at or below the ceiling; the largest size above every band (never asked for, but
 * total). Since 2026-09-13 there is one band, so every target answers `"79m"`; the rating still
 * travels in the query (`selfElo` / `oppoElo`), which is where the Elo slider acts.
 */
export function maiaSizeFor(targetElo: number): MaiaSize {
	for (const band of MAIA.sizeBands) if (targetElo < band.maxElo) return band.size;
	const last = MAIA.sizeBands[MAIA.sizeBands.length - 1];
	return last?.size ?? MAIA.defaultSize;
}
