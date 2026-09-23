/**
 * The v1 parametric head (Appendix D §3a.3–§3a.5): body coefficients, residual, premove and
 * instant spikes, long-think tail, tilt, and the settings-knob mapping.
 */

import type { TcClass } from "../types";

/** Appendix D §3a.3 body coefficients (log scale). */
export const BETA = {
	book: [-1.2, -0.4],
	phaseMid: 0.15,
	phaseEnd: -0.1,
	invertedU: 0.25,
	uCentrePly: 36,
	uWidth: 1600,
	cplx: [0.35, 0.15],
	cplxRefLines: 3,
	dec: [0.22, 0.06],
	gap: 0.1,
	forced: -0.9,
	recap: -0.8,
	only: -1.5,
	ponder: -0.45,
	swing: 0.3,
	evalAbs: -0.18,
	lost: 0.2,
	lostLoCp: -600,
	lostHiCp: -120,
	dead: -0.35,
	deadCp: -600,
	won: -0.3,
	wonCp: 500,
	check: -0.1,
	promo: 0.15,
	legal: 0.1,
	legalRefMoves: 30,
	ratio: 0.08,
} as const;

/** Appendix D §3a.4 residual. */
export const SIGMA = { base: 0.8, elo: -0.12, phaseMid: 0.1, book: -0.08, min: 0.05 } as const;

export const PHI = { base: 0.35, elo: 0.05 } as const;

/** Appendix D §3a.5 premove spike. */
export const PREMOVE = {
	aTc: { bullet: -0.4, blitz: -2, rapid: -3.5, classical: -5, untimed: -5 } as Record<
		TcClass,
		number
	>,
	recap: 2,
	book: 1.5,
	only: 1.5,
	ponder: 1,
	clockUnder10: 1.5,
	clockUnder20: 0.8,
	clock10S: 10,
	clock20S: 20,
	lnNReasonable: -0.6,
	swingBad: -0.3,
	eloBullet: 0.6,
	/** `t_premove ~ U(0, maxS)` plus the site's fixed submit penalty. */
	maxS: 0.12,
	penaltyS: 0.1,
} as const;

/** Appendix D §3a.5 instant reply. */
export const INSTANT = {
	bTc: { bullet: 0.2, blitz: -0.9, rapid: -1.8, classical: -2.5, untimed: -2.5 } as Record<
		TcClass,
		number
	>,
	recap: 1.2,
	forced: 1,
	ponder: 0.8,
	book: 1,
	clockUnder20: 0.8,
	lnNReasonable: -0.5,
	iota: 0.5,
	/**
	 * §3a.5's `−0.3·decisiveness⁻¹` term (absent from the condensed Appendix A; §3a.5 wins),
	 * evaluated as `1 / max(decisiveness, floor)` so two equal moves give a finite penalty.
	 */
	decisivenessInv: -0.3,
	decisivenessInvFloor: 0.25,
	/** `t = t_motor + U(minS, minS + rangeS)`. */
	minS: 0.05,
	rangeS: 0.2,
} as const;

/** Appendix D §3a.5 long-think tail. */
export const LONG_THINK = {
	lambda0: [0.02, 0.008],
	critExp: 0.9,
	tauBase: 0.6,
	tauWeight: 0.4,
	pMax: 0.12,
	paretoAlpha: 1.6,
	paretoXm: 1,
	paretoShift: 2.5,
	minClockS: 30,
	minPressure: 0.15,
	crit: { lnN: 0.5, swing: 0.4, balanced: 0.3, balancedCp: 150, phaseMid: 0.3, dec: -0.3, max: 2 },
	capFraction: 0.25,
	capS: { bullet: 15, blitz: 45, rapid: 120, classical: 120, untimed: 120 } as Record<
		TcClass,
		number
	>,
} as const;

/** Tilt: 3 moves after an own move that lost ≥ 200 cp. */
export const TILT = { moves: 3, dropCp: 200, bodyIota: 0.35, instantIota: 0.6 } as const;

/** Appendix D §7: v2 MLP head (not shipped; kept for the knob table). */
export const V2_MLP = { arSigma: 0.35, temperature: 1 } as const;

/** `Settings.timing.premoveTendency` ∈ [0,1] maps to the ±2 logit knob (Appendix D §7 knob 5). */
export const KNOBS = { premoveNeutral: 0.5, premoveLogitSpan: 4 } as const;
