/**
 * Motor design constants — every number of Part I §9.3–§9.5 and Appendix G
 * §2.3, §7–§8 lives here exactly once (C1). Rates are design constants (V2.3:
 * no behaviour dataset); the conformance harness checks plausibility bands.
 */

import type { PersonaId } from "@typedefs/settings";
import type { MotorMoveKind, MotorProfile, MotorStyle, MsRange, TimeControlClass } from "./types";

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

/**
 * Click mechanics (§9.3, §13.5). A *committed* move is always a drag, so there is no inter-click
 * gap here any more; what is left serves the preview selections (§9.3a) and the drag's own
 * pre-press pause.
 */
export const CLICK = {
	/** Real click drift: press and release within 2 px (integer ±1). */
	releaseDriftPx: 1,
	prePressPauseMs: [15, 60] as MsRange,
	preGrabPauseMs: [20, 70] as MsRange,
} as const;

export const PROMOTION_LOOK_DELAY_MS: MsRange = [150, 400];

/**
 * §9.3a preview-selection model: `p_preview = clamp(base · f · g · scale, 0, cap)` —
 * the settings scale is applied BEFORE the cap (ruling), so `scale > 1` cannot exceed it.
 */
export const PREVIEW = {
	base: { cautious: 0.04, balanced: 0.07, aggressive: 0.1, blitz: 0.05 } satisfies Record<
		PersonaId,
		number
	>,
	/** f = 1 + fSlope·(n_reasonable − 1). */
	fSlope: 0.35,
	/** g ramp: 0 below `gZeroMs`, 1 at `gOneMs`, `gMaxValue` at `gMaxMs`. */
	gZeroMs: 1200,
	gOneMs: 4000,
	gMaxMs: 10_000,
	gMaxValue: 1.6,
	cap: 0.35,
	clockFloorMs: 15_000,
	secondPreviewFactor: 0.25,
	differentPieceProb: 0.8,
	/** Resolve by switching selection (else click an empty square first). */
	switchProb: 0.8,
	dragStyleProb: 0.35,
	dwellMs: [300, 1200] as MsRange,
	dragDisplacementPx: [8, 40] as MsRange,
	/** Drag previews release within this distance of the press, inside the origin square. */
	dragReturnSigmaPx: 3,
	/** Target rect for the outbound leg of a drag preview. */
	dragTargetRectPx: 6,
	/** Deselect squares within this king-distance of the piece are preferred. */
	deselectMaxDistance: 3,
	/** Time reserved for the preview before the scan phase spends the budget. */
	reserveMs: 2200,
} as const;

/** §9.3 exploration planner and §8.4b phase allocation. */
export const EXPLORATION = {
	/** Below this pre-touch budget the plan is `[rest]` only. */
	minWindowMs: 600,
	orientationFrac: [0.05, 0.15] as MsRange,
	decisionPauseFrac: [0.15, 0.4] as MsRange,
	hoverDwellMs: [200, 900] as MsRange,
	hoverCountWeights: [0.55, 0.3, 0.15],
	/** P(any hover) = hoverProb·(1 + nSlope·(n−1))·ramp(waitMs), capped. */
	hoverNSlope: 0.2,
	hoverRampMs: [600, 3000] as MsRange,
	hoverProbCap: 0.95,
	traceFrac: [0.4, 0.9] as MsRange,
	traceDwellMs: [100, 300] as MsRange,
	/** Feint: pause over the piece as if to grab, then pull back this far. */
	feintDwellMs: [80, 200] as MsRange,
	feintRetreatPx: [10, 30] as MsRange,
	tracePointRectPx: 6,
	/** Idle tremor covers at most this fraction of a rest. */
	restTremorFrac: 0.6,
	/** Resting on the dropped piece: Gaussian σ and hard radius around the anchor. */
	restPieceSigmaPx: 10,
	restPieceMaxPx: 30,
} as const;

/** Appendix G §8 time-control modulation (partial overrides of `MOTOR_DEFAULTS`). */
export const TC_MODULATION: Readonly<Record<TimeControlClass, Partial<MotorProfile>>> = {
	bullet: {
		reactionMs: [120, 260],
		fittsA: 0.08,
		fittsB: 0.12,
		travelSpeedScale: 0.7,
		pressHoldMs: [35, 80],
		hesitationProb: 0.05,
		overshootProb: 0.1,
	},
	blitz: {
		reactionMs: [150, 350],
		fittsA: 0.08,
		fittsB: 0.12,
		travelSpeedScale: 0.75,
		pressHoldMs: [35, 80],
		hesitationProb: 0.05,
		overshootProb: 0.1,
	},
	rapid: {},
	classical: { travelSpeedScale: 1.3, hesitationProb: 0.2, releaseSettleMs: [30, 110] },
};

/**
 * Appendix G §8 modulation of the *exploration* rates by time-control class. `TC_MODULATION` is a
 * shallow override of the profile, so the nested `exploration` block cannot be modulated there
 * without repeating every field of it; this table scales the rates instead, once (C1).
 *
 * The hover appetite is the behaviour that reads as the hand "touching pieces before it moves"
 * (the owner's live game): measured over 420 moves of a simulated 3+0 game, the hand hovered a
 * candidate piece on 75 % of the moves whose pre-touch window was long enough to explore at all
 * — the slow, conspicuous moves a watcher notices — and on a saturated window at rapid the
 * unscaled model hovers on 0.775 of them.
 *
 * **The rule these numbers come from: hovering must be something the hand sometimes does, never
 * its default.** "Not its default" is `< 0.5` on the windows where the `hoverRampMs` ramp is
 * saturated, evaluated at four reasonable moves — production's worst case at the shipped
 * `Settings.engine.multiPv` of 4, since `n_reasonable` can never exceed the number of lines — where
 * the planner's `f = 1 + hoverNSlope·(n−1)` is 1.6. That caps the scale at
 * `0.5 / 1.6 / MOTOR_DEFAULTS.exploration.hoverProb` = 0.568, so rapid and classical take 0.55 —
 * the rule's own ceiling, rounded down. A faster clock browses less still: a blitz or bullet hand
 * goes straight for the piece. Realised rates on a 3500 ms window (3000 seeds, n = 4): bullet
 * 0.269, blitz 0.391, rapid and classical 0.426.
 *
 * **The limit of that guarantee: it holds at the shipped MultiPV, not at every setting.** The
 * n-term keeps rising, and a user who raises `multiPv` toward `LIMITS.multiPvMax` (8) takes the
 * rapid rate back to where the complaint started — model 0.726 at n = 8, realised 0.59 on a
 * 3500 ms window and ≈ 0.70 on longer ones. Raising the shipped default therefore means
 * re-deriving this table, which `motor-profile.test.ts` makes a failing test rather than a
 * judgement call. There is no behaviour dataset behind any of this (see `MOTOR_DEFAULTS`); the
 * rule is the justification, and this table is the lever if the owner still sees the hand
 * touching pieces.
 */
export const TC_EXPLORATION: Readonly<Record<TimeControlClass, { hoverProb: number }>> = {
	bullet: { hoverProb: 0.35 },
	blitz: { hoverProb: 0.5 },
	rapid: { hoverProb: 0.55 },
	classical: { hoverProb: 0.55 },
};

/** Mild persona modulation (Elo affects think time far more than motor time). */
export const PERSONA_MOTOR: Readonly<
	Record<
		PersonaId,
		{ fittsA: number; jitter: number; hesitation: number; microCorrection: number; speed: number }
	>
> = {
	cautious: { fittsA: 1.1, jitter: 1.1, hesitation: 1.3, microCorrection: 1.2, speed: 1 },
	balanced: { fittsA: 1, jitter: 1, hesitation: 1, microCorrection: 1, speed: 1 },
	aggressive: { fittsA: 0.9, jitter: 0.9, hesitation: 0.8, microCorrection: 0.9, speed: 1 },
	blitz: { fittsA: 0.9, jitter: 1, hesitation: 0.7, microCorrection: 0.9, speed: 0.9 },
};

/** Move-type modulation: premoves ×0.7, blitz captures ×0.8, promotions add the look-delay. */
export const MOVE_KIND_MODULATION: Readonly<
	Record<MotorMoveKind, { speed: number; reaction: number; fastTcOnly: boolean }>
> = {
	normal: { speed: 1, reaction: 1, fastTcOnly: false },
	premove: { speed: 0.7, reaction: 0.7, fastTcOnly: false },
	capture: { speed: 0.8, reaction: 1, fastTcOnly: true },
	recapture: { speed: 0.8, reaction: 0.9, fastTcOnly: true },
	promotion: { speed: 1, reaction: 1, fastTcOnly: false },
	castle: { speed: 1, reaction: 1, fastTcOnly: false },
};

/** Per-game ±10 % offsets, per-move lognormal noise (σ) clamped to ±25 %. */
export const PROFILE_NOISE = {
	perGameOffset: 0.1,
	perMoveSigma: 0.1,
	perMoveClamp: 0.25,
} as const;

/** Per-game dominant path style (70/30), never a per-move coin flip. */
export const STYLE_MIX_PER_GAME: Readonly<Record<MotorStyle, { bezier: number; wind: number }>> = {
	bezier: { bezier: 0.85, wind: 0.15 },
	wind: { bezier: 0.3, wind: 0.7 },
};

/** Opponent-turn free movement: short activity bouts interleaved with quiet observation. */
export const OPPONENT_EXPLORATION = {
	maxCandidates: 10,
	replyBranches: 4,
	initialRestMs: [1000, 2200] as MsRange,
	lowTimeInitialRestMs: [600, 1000] as MsRange,
	lowTimeBoutMs: [1800, 3200] as MsRange,
	lowTimeActiveFrac: [0.3, 0.5] as MsRange,
	lowTimeVisits: [1, 2] as MsRange,
	boutMs: [3200, 7800] as MsRange,
	activeFrac: [0.68, 0.88] as MsRange,
	orientationMs: [100, 420] as MsRange,
	visits: [2, 5] as MsRange,
	ownBias: [0.38, 0.62] as MsRange,
	switchSideProb: 0.7,
	traceProb: 0.65,
	hoverDwellMs: [180, 650] as MsRange,
	traceDwellMs: [140, 500] as MsRange,
	betweenVisitsMs: [90, 360] as MsRange,
	minDwellMs: 100,
} as const;

/** A clock-race gesture spends its budget on the two useful legs, with no decorative delays. */
export const FAST_TOUCH = {
	minBudgetMs: 20,
	maxBudgetMs: 300,
	sampleMs: 16,
	minLegFrac: 0.2,
	maxLegFrac: 0.8,
	promotionTravelMs: [24, 60] as MsRange,
} as const;
