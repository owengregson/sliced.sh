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

/**
 * The line preview (owner, 2026-09-12): on a long think the hand occasionally maps out the line it
 * is considering the way a player previews a sequence before moving — a **right-button** drag from
 * the from-square to the to-square for each ply of the chosen move's PV (our move, their reply,
 * our next move …), which chess.com renders as an arrow, with a human pause between arrows and a
 * longer look at the finished line; now and then a second line (an alternative candidate's PV)
 * after a pause. The move's own left press then clears every arrow on the site. Planned by
 * `src/core/motor/line-preview.ts`, drawn by the hand inside the decision phase.
 *
 * Every number of that gesture lives here (C1). Durations are `[lo, hi]` ms ranges sampled
 * uniformly per arrow / per line from the preview's own seeded stream.
 */
export const LINE_PREVIEW = {
	/** Only a think planned at least this long gets a preview (≈ 6 s: the gesture itself is seconds). */
	minThinkMs: 6000,
	/** The same clock floor as the §9.3a previews: nobody annotates in time trouble. */
	minClockMs: PREVIEW.clockFloorMs,
	/**
	 * Plies of the line drawn: sampled in this range, clipped to the PV's legal length (owner,
	 * 2026-09-12: "aim for 3–7 plies of play"). The fit loop shortens a line the window cannot hold.
	 */
	plies: [3, 7] as MsRange,
	/**
	 * "Prioritize pieces that are doing something active near the piece that was just moved": a
	 * line's activity is the number of its plies whose from- or to-square lies within `nearRadius`
	 * (Chebyshev) of the opponent's last-moved piece. Alternatives are drawn with weight
	 * `1 + nearWeight · activity`, and a second line is more likely when an active one exists.
	 */
	nearRadius: 2,
	nearWeight: 2.5,
	nearSecondLineProb: 0.55,
	/**
	 * P(preview | eligible) by planned think time — `[thinkMs, p]` knots, linear between, flat
	 * beyond the ends. Rises with the think: a 6 s think previews rarely, a 20 s think half the time.
	 */
	probability: [
		[6000, 0.12],
		[10_000, 0.3],
		[20_000, 0.5],
	] as ReadonlyArray<readonly [number, number]>,
	/** A second line (another candidate's PV, first ply different) follows the first this often. */
	secondLineProb: 0.25,
	/** Hard per-game cap on moves that get a preview, so it stays an occasional thing. */
	maxPerGame: 6,
	/** Pause between two arrows of one line (the eye moving to the next piece). */
	betweenArrowsMs: [350, 1100] as MsRange,
	/** Looking at the finished line before anything else happens. */
	afterLineMs: [700, 1800] as MsRange,
	/** Pause before a second line is started. */
	betweenLinesMs: [500, 1400] as MsRange,
	/** Pause on the from-square before the right button goes down. */
	prePressMs: [30, 110] as MsRange,
	/** Right button held still before the drag sets off (shorter than a piece grab: nothing is picked up). */
	pressToDragMs: [40, 140] as MsRange,
	/** Settle over the to-square before the right button comes up. */
	releaseSettleMs: [30, 120] as MsRange,
	/** The hand rests after the last arrow before the approach begins (part of the decision pause). */
	restBeforeApproachMs: [250, 700] as MsRange,
	/**
	 * Budget margin: the whole gesture (estimated from the profile's Fitts times plus the sampled
	 * pauses) must fit inside the window's scan + preview + decision phases with this much to
	 * spare, so the decision pause never collapses and the approach starts on time. The planner
	 * charges the estimate against the exploration budget (fewer hovers on a previewed move).
	 */
	marginMs: 600,
	/** Per-leg allowance on top of the Fitts estimate for the path generator's overshoots/corrections. */
	travelAllowanceMs: 150,
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

/**
 * Opponent-turn free movement ("pondering", owner 2026-09-12): an *attention plan* of alternating
 * active spells and stills over the opponent's think, with the places the pointer visits read from
 * the position rather than browsed from a candidate list. Every number is a design constant with no
 * behaviour dataset behind it (see `MOTOR_DEFAULTS`); the comment on each says what it is set from.
 */
export const OPPONENT_EXPLORATION = {
	maxCandidates: 10,
	replyBranches: 4,
	/** Lines read as reply → answer → next (the top `readingLines` PVs, at most `readingPlies` plies). */
	readingLines: 3,
	readingPlies: 3,
	/** Threat checks look at our pieces the top `threatReplies` replies attack. */
	threatReplies: 3,
	/**
	 * Quiet before the first bout. Short since the post-drop decision (owner, 2026-09-11) already
	 * chose between resting over a piece and pondering at once; this is the settle, not the rest.
	 */
	initialRestMs: [400, 900] as MsRange,
	lowTimeInitialRestMs: [300, 600] as MsRange,
	lowTimeBoutMs: [1800, 3200] as MsRange,
	lowTimeActiveFrac: [0.3, 0.5] as MsRange,
	lowTimeVisits: [1, 2] as MsRange,
	/**
	 * Fallback spell shape when no attention context is supplied (tests, a session without clocks):
	 * the pre-2026-09-12 bout, an active stretch then a still.
	 */
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
	/**
	 * The attention plan by time-control class. `firstLookMs` is the short first look at the
	 * position after our move; `activeMs`/`stillMs` the spells that alternate after it (bullet:
	 * short and frequent, classical: long stills); `noPonderProb` the share of opponent turns that
	 * get no pondering at all beyond a rest — highest where the expected think is shortest (bullet:
	 * the reply is due before a look is worth it) and raised again at classical (a long expected
	 * think: the hand leans back); `decayHalfLifeMs` the opponent think after which attention has
	 * halved (stills grow, activity thins to an occasional glance — the *very long* think in the
	 * brief). Set from the median human move times per class in the ChessMimic bands (bullet ≈ 1.5 s,
	 * blitz ≈ 4 s, rapid ≈ 10 s, classical ≈ 25 s): a spell is about a third of a median think, a
	 * still about a half, the half-life about two thinks. The first look is long enough to read one
	 * line (six legs of travel and dwell) and is not phase-scaled.
	 */
	attention: {
		bullet: {
			firstLookMs: [600, 1300] as MsRange,
			activeMs: [900, 2000] as MsRange,
			stillMs: [400, 1200] as MsRange,
			noPonderProb: 0.35,
			decayHalfLifeMs: 3_000,
		},
		blitz: {
			firstLookMs: [800, 1800] as MsRange,
			activeMs: [1400, 3400] as MsRange,
			stillMs: [800, 2200] as MsRange,
			noPonderProb: 0.18,
			decayHalfLifeMs: 8_000,
		},
		rapid: {
			firstLookMs: [1100, 2600] as MsRange,
			activeMs: [2200, 5200] as MsRange,
			stillMs: [1500, 4500] as MsRange,
			noPonderProb: 0.1,
			decayHalfLifeMs: 20_000,
		},
		classical: {
			firstLookMs: [1400, 3200] as MsRange,
			activeMs: [2600, 7000] as MsRange,
			stillMs: [2500, 8000] as MsRange,
			noPonderProb: 0.14,
			decayHalfLifeMs: 50_000,
		},
	} satisfies Record<
		TimeControlClass,
		{
			firstLookMs: MsRange;
			activeMs: MsRange;
			stillMs: MsRange;
			noPonderProb: number;
			decayHalfLifeMs: number;
		}
	>,
	/**
	 * Attention decay, applied with `a = 2^(−think / decayHalfLifeMs)`: a still grows by up to
	 * `stillGrowthMax` × (1 − a); the chance that a cycle is active at all falls from 1 toward
	 * `activeFloor`; a cycle that is not active is a single glance with `glanceProb`, else pure
	 * stillness. Set so a fully decayed rapid turn (a ≈ 0) shows one glance per ~15 s.
	 */
	decay: { stillGrowthMax: 2, activeFloor: 0.3, glanceProb: 0.5 },
	/**
	 * A short expected reply (the opponent's clock under `quickReplyClockMs`) adds
	 * `noPonderShortBoost` to the no-ponder share: there is no time for a look before they move.
	 */
	quickReplyClockMs: 15_000,
	noPonderShortBoost: 0.25,
	/**
	 * Game phase (`@core/chess/phase`): opening spells are quick glances (×`opening`), a sharp
	 * middlegame (a capture or check in the top replies) holds longer traces (×`sharp`), the endgame
	 * is between (×`endgame`). Multipliers on the active spell length.
	 */
	phaseActiveScale: { opening: 0.7, middlegame: 1, sharp: 1.35, endgame: 0.85 },
	/**
	 * With a premove or a hold armed the hand is mostly still: the chance a cycle is active, and
	 * the active length multiplier. A held piece cannot ponder at all (the executor never starts a
	 * bout while a hold runs); this covers an armed premove and the checkpoints between.
	 */
	armed: { activeProb: 0.2, activeScale: 0.5 },
	/**
	 * What an active spell does, as weights (the `line`/`threat` weights are scaled by `sharp` in
	 * a sharp position). `candidates` is the pre-2026-09-12 browse, kept as the fallback for a
	 * position with no readable lines.
	 */
	activityWeights: { line: 5, threat: 3, candidates: 2, king: 1, offBoard: 0.5 },
	sharpActivityScale: 1.5,
	/**
	 * The first activity of any active spell (the first look included) is a line reading nearly
	 * always — a human opens a look with the most likely line (multiplier on `line`; ×2.5 leaves a
	 * threat check about a sixth of the openings, which the unit test derives from these weights).
	 */
	firstLookLineScale: 2.5,
	/** Candidate visits per `candidates` activity inside an attention spell (the legacy browse uses `visits`). */
	activityCandidateVisits: [1, 2] as MsRange,
	/** A line is read twice with this probability (a second, quicker pass). */
	rereadProb: 0.3,
	rereadSpeedScale: 0.8,
	/**
	 * Dwells inside a line reading: on the piece (`from`) and on the destination (`to`). Short —
	 * a reading is six legs, and the eye moves on as soon as the move is seen.
	 */
	readFromDwellMs: [100, 300] as MsRange,
	readToDwellMs: [150, 500] as MsRange,
	/** Threat check: pieces looked at per spell, dwell on each (a worried look is longer). */
	threatVisits: [1, 3] as MsRange,
	threatDwellMs: [300, 1100] as MsRange,
	/** The piece the opponent just moved is looked at first in a threat check with this probability. */
	lastMoveFirstProb: 0.6,
	/**
	 * King glance: which king (own more often — "am I safe?") and how long. Also drawn as an
	 * *extra* at the start of any active spell with `kingGlanceProb` (a look at the king before
	 * reading), so the rate over a turn lands in the band the unit test pins.
	 */
	kingOwnProb: 0.65,
	kingDwellMs: [250, 800] as MsRange,
	kingGlanceProb: 0.12,
	/**
	 * Off-board glance: the clock / move-list area beside the board (`SAMPLING.clockBandPx` to the
	 * right, the same band `plausibleStart` uses) or just past an edge (`SAMPLING.offBoardPx`),
	 * never above the viewport origin. Rare — `offBoardGlanceProb` per active spell as an extra,
	 * drawn with the king glance before the spell's activities — with a dwell that reads a clock.
	 */
	offBoardGlanceProb: 0.06,
	offBoardClockProb: 0.7,
	offBoardDwellMs: [350, 1200] as MsRange,
	/**
	 * A still begins with a walk to a rest spot with `restMoveProb` (else the hand stays where the
	 * spell left it): a random piece drawn toward the centre with `EXECUTOR.postDropCentreBias`
	 * (`restPieceProb`), else a point just off the board edge. Never the square we intend to move
	 * to next. Stills hold `stillDwellMs` per dwell — fewer, longer dwells than an active spell.
	 */
	restMoveProb: 0.45,
	restPieceProb: 0.75,
	stillDwellMs: [900, 2600] as MsRange,
	/** The first movement after a still is slower (re-orienting): multiplier on `travelSpeedScale`. */
	reorientSpeedScale: 1.3,
	/** Per-spell trace speed jitter on the persona's motor profile (multiplier on `travelSpeedScale`). */
	traceSpeedScale: [0.85, 1.2] as MsRange,
	/** A glance cycle (decayed attention): one hover, then the still. `glanceMs` covers the travel. */
	glanceMs: [1000, 2200] as MsRange,
	glanceDwellMs: [300, 900] as MsRange,
	/** An active spell too short for its chosen leg tries this many nearest squares for a look. */
	nearestLookTries: 4,
	/** The orientation pause opening an active spell never takes more than this share of it (bullet). */
	orientationMaxFrac: 0.2,
	/** Off-board glance points stay at least this far inside the viewport. */
	viewportPadPx: 4,
} as const;

/** A clock-race gesture spends its budget on the two useful legs, with no decorative delays. */
/**
 * Click-to-move as a committed gesture (owner, 2026-09-11; `Settings.execution.inputMode`): click
 * the piece, carry the pointer over, click the square. `autoClickProb` is the per-move share of
 * clicks in `auto` mode; premoves and holds are drags regardless.
 */
export const CLICK_MOVE = {
	/**
	 * `auto`'s per-move click share by how far the piece travels (owner, 2026-09-11: "moves that
	 * move the piece FARTHER across the board (4+ squares) have higher chance to be a drag"): a
	 * short hop is a click a third of the time, a long carry (Chebyshev distance ≥ `farSquares`)
	 * only rarely — a human clicks to nudge a piece and drags to carry it across the board.
	 */
	autoClickProb: 0.34,
	autoClickProbFar: 0.12,
	farSquares: 4,
	/**
	 * Low on time a human clicks rather than drags (owner, 2026-09-12: "humans cant drag so
	 * precisely with little time left") — unless the move is a premove or a hold, which are drags
	 * by construction. The click share ramps linearly from the ordinary value at `lowTimeRampMs`
	 * left to `lowTimeClickProb` at `lowTimeMs` and below, whatever the distance.
	 */
	lowTimeRampMs: 30_000,
	lowTimeMs: 10_000,
	lowTimeClickProb: 0.75,
	/** Between letting go of the piece and setting off for the square. */
	interClickGapMs: [90, 320] as MsRange,
} as const;

export const FAST_TOUCH = {
	/** The lowest an urgent plan may be fitted to when the deadline has already passed. */
	minBudgetMs: 60,
	maxBudgetMs: 300,
	/**
	 * The hard floor on the gesture itself: approach + press + carry + drop never total less than
	 * this, whatever the plan's window says (owner, 2026-09-11 — the executor could act faster than
	 * any hand). The physical floor of a human press-carry-drop over a couple of squares.
	 */
	gestureFloorMs: 150,
	sampleMs: 16,
	minLegFrac: 0.2,
	maxLegFrac: 0.8,
	promotionTravelMs: [24, 60] as MsRange,
} as const;
