/** Appendix D §2 feature scalings and the clockless virtual context. */

/** Appendix D §2 feature scalings. */
export const FEATURES = {
	/** `elo_z = (elo − centre) / halfRange`, clamped to ±1. */
	eloCentre: 1650,
	eloHalfRange: 850,
	/** `base_eff = base + incWeight·inc` and the Lichess class thresholds (seconds). */
	incWeight: 40,
	bulletMaxBaseEff: 180,
	blitzMaxBaseEff: 480,
	rapidMaxBaseEff: 1500,
	/** `log_clock = ln(max(clockFloorS, clock))`. */
	clockFloorS: 0.5,
	clockRatioClamp: 2,
	/** `ply_sq = (ply / plySqScale)²`. */
	plySqScale: 40,
	/** `phase_c = clamp((phaseMaterialFull − npm) / phaseMaterialFull, 0, 1)`. */
	phaseMaterialFull: 62,
	/** Lines within this many cp of the best count as reasonable. */
	nReasonableCp: 40,
	decisivenessScaleCp: 25,
	/** `is_forced = n_reasonable == 1 && decisiveness > ln(1 + forcedCp / 25)`. */
	forcedCp: 150,
	swingScaleCp: 50,
	evalAbsScaleCp: 100,
	evalSignScaleCp: 300,
	materialScale: 5,
	/** `opp_pace` window and the `+0.2` offset; disabled below 20 s (Appendix D §4). */
	oppPaceMoves: 3,
	oppPaceOffsetS: 0.2,
	oppPaceClamp: 2,
	oppPaceMinClockS: 20,
	/** `budget_used_ratio = 1 − pressure − min(1, ply / (2·N0))`. */
	expectedMovesN0: 40,
} as const;

/**
 * Clockless games (§8.4b items 1 and 6): ONE virtual context shared by the features, the
 * budget bypass and the ChessMimic inputs (a blitz context inside ChessMimic's training
 * range). The clock-pressure terms and the budget controller are bypassed, which is what
 * "classical conditioning" means here — not a long virtual base.
 */
export const UNTIMED_VIRTUAL = { clockS: 300, incS: 0 } as const;
