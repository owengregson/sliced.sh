/** The move budget: the Appendix D §3a.2 controller, rating pace and the per-move budget shape. */

/** Appendix D §3a.2 budget controller. */
export const BUDGET = {
	nRemBase: 24,
	nRemPerPiece: 0.9,
	nRemPerPawn: 0.5,
	nRemPerMove: 0.12,
	nRemMin: 24,
	nRemMax: 48,
	openingHorizonPlies: 40,
	reserveFraction: 0.08,
	reserveMinS: 2,
	reserveMaxS: 30,
	allocMinS: 0.15,
	allocIncWeight: 0.8,
	overspendFactor: 0.12,
	overspendPlyHorizon: 60,
} as const;

/** Engineering priors, not population estimates. Interpolated continuously from 400–3800. */
export const RATING_PACE = {
	// Elo, recognition, complexity contrast, time-management discipline.
	knots: [
		[400, 0.12, 0.2, 0.35],
		[800, 0.22, 0.3, 0.43],
		[1200, 0.38, 0.43, 0.53],
		[1600, 0.56, 0.59, 0.65],
		[2000, 0.74, 0.75, 0.77],
		[2400, 0.86, 0.89, 0.86],
		[2800, 0.92, 0.97, 0.91],
		[3200, 0.94, 1.0, 0.93],
		[3800, 0.95, 1.0, 0.94],
	] as ReadonlyArray<readonly [number, number, number, number]>,
} as const;

export const MOVE_BUDGET = {
	complexityReferenceChoices: 6,
	swingScale: 2,
	routineEffort: 0.7,
	complexityEffort: 0.75,
	recognitionDiscount: 0.78,
	minimumEffort: 0.16,
	maximumEffort: 1.65,
	minimumShapeMeanS: 0.05,
	normalBurst: 3,
	criticalBurst: 6,
	clockFraction: 0.16,
	incrementBurst: 2,
} as const;
