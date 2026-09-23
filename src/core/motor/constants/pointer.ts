/**
 * Pointer mechanics (Appendix G §2.3, §7–§8): the sample rate, the default motor profile, the
 * minimum-jerk / Bézier / WindMouse path constants and the press/release sampling bands.
 */

import type { MotorProfile, MsRange } from "../types";

/** 125 Hz USB mouse; Chrome frame-coalesces (Appendix G §7.4). */
export const SAMPLE_INTERVAL_MS = 8;

/** Appendix G §8 defaults (rapid baseline). */
export const MOTOR_DEFAULTS: Readonly<MotorProfile> = Object.freeze<MotorProfile>({
	version: 1,
	reactionMs: [250, 600] as MsRange,
	fittsA: 0.15,
	fittsB: 0.2,
	travelSpeedScale: 1,
	peakSpeedCapPxPerS: 3500,
	jitterPx: 1.2,
	overshootProb: 0.08,
	hesitationProb: 0.12,
	microCorrectionProb: 0.3,
	pressHoldMs: [40, 120] as MsRange,
	grabDelayMs: [30, 90] as MsRange,
	releaseSettleMs: [20, 80] as MsRange,
	sampleIntervalMs: SAMPLE_INTERVAL_MS,
	lookDelayMs: [0, 0] as MsRange,
	styleMix: { bezier: 0.7, wind: 0.3 },
	exploration: { hoverProb: 0.55, feintProb: 0.15, previewBase: 0.07, restStyle: "mixed" },
});

/** Minimum-jerk profile `s(τ) = 10τ³ − 15τ⁴ + 6τ⁵`; peak speed = 1.875·D/MT. */
export const MIN_JERK = { c3: 10, c4: -15, c5: 6, peakSpeedFactor: 1.875 } as const;

/** Appendix G §7.3 path-generator constants. */
export const PATH = {
	/** AR(1) tremor correlation. */
	tremorRho: 0.6,
	/** Suppress sample noise on small corrections; full macro-path noise above the upper bound. */
	noiseRampPx: [12, 48] as MsRange,
	/** ghost-cursor clamps the anchor spread to 2..200 px, then × U(0.05, 0.25). */
	bezierSpreadPx: [2, 200] as MsRange,
	bezierSpreadFrac: [0.05, 0.25] as MsRange,
	anchorT1: [0.2, 0.4] as MsRange,
	anchorT2: [0.6, 0.8] as MsRange,
	anchorS1: [0.4, 1] as MsRange,
	anchorS2: [0.2, 0.8] as MsRange,
	arcTableSteps: 64,
	/** Fitts multiplier U(0.85, 1.2); shortest ballistic segment; smallest effective width. */
	fittsJitter: [0.85, 1.2] as MsRange,
	minSegmentMs: 60,
	minWidthPx: 8,
	/** Nominal peak speed stays at this fraction of the cap so tremor cannot exceed it. */
	capHeadroom: 0.92,
	/** Steps that would exceed the cap are shortened to `maxStep − stepLimitMarginPx`. */
	stepLimitMarginPx: 1,
	/** Cap-limited steps allowed to reach the exact landing point after a segment. */
	settleMaxSteps: 64,
	overshoot: {
		/** Probability × min(maxFactor, D / distScalePx). */
		distScalePx: 250,
		maxFactor: 2,
		frac: [0.04, 0.12] as MsRange,
		extraPx: [4, 10] as MsRange,
		sigmaPx: 3,
		widthFactor: 1.5,
		pauseMs: [30, 90] as MsRange,
		correctMs: [120, 250] as MsRange,
	},
	microCorrection: {
		sigmaPx: 2.5,
		minShiftPx: 3,
		padPx: 4,
		pauseMs: [20, 60] as MsRange,
		durMs: [60, 120] as MsRange,
	},
	/** Final landing must be this far inside the target rect. */
	targetPadPx: 2,
	grabWobble: {
		points: [2, 4] as MsRange,
		sigmaPx: 0.8,
		dtMs: [8, 22] as MsRange,
		maxOffsetPx: 3,
	},
	hesitationWobbleDtMs: [40, 90] as MsRange,
	/** A resting hand is usually still; at most one small adjustment in a long pause. */
	idle: {
		adjustmentProb: 0.18,
		minRestMs: 900,
		delayMs: [650, 1800] as MsRange,
		sigmaPx: 0.7,
		maxOffsetPx: 3,
	},
} as const;

/** Appendix G §2.3 WindMouse (Ben Land: G 9, W 3, M 15, D 12; maxStep ≤ 11 keeps the first rounded step ≤ 12 px). */
export const WIND = {
	gravity: [9, 11] as MsRange,
	wind: [3, 8] as MsRange,
	minWaitMs: 5,
	maxWaitMs: 12,
	maxStep: [8, 11] as MsRange,
	targetArea: [8, 12] as MsRange,
	maxIterations: 2000,
	/** Inside `targetArea` a small `maxStep` is re-randomised to 3–6. */
	dampedStepFloor: 3,
	dampedStepRange: 3,
	/** Rescaled samples never get shorter than this. */
	minDtMs: 4,
} as const;

/** Appendix G §7.2 press/release sampling and the plausible-start bands (§4). */
export const SAMPLING = {
	press: { sigmaFrac: 0.18, innerFrac: 0.7 },
	release: { sigmaFrac: 0.22, innerFrac: 0.8 },
	hover: { sigmaFrac: 0.25, innerFrac: 0.9 },
	promotion: { sigmaFrac: 0.2, innerFrac: 0.7 },
	truncGaussTries: 8,
	/** Rest / start bands: own half of the board, near the clock, just off the board edge. */
	startWeights: { ownHalf: 0.6, clock: 0.25, offBoard: 0.15 },
	clockBandPx: [20, 120] as MsRange,
	offBoardPx: [6, 40] as MsRange,
} as const;
