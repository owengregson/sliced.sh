/**
 * `TIMING_CONSTANTS` — Appendix D §7 (default parameter table) plus the §8 /
 * §8.4b constants, transcribed ONCE (C1). Every number of the timing model
 * lives here; the modules under `src/core/timing/` only read it.
 *
 * Elo-dependent parameters are `[p0, p1]` pairs: `p(e) = p0 + p1·elo_z`.
 */

import type { PersonaId } from "@typedefs/settings";
import type { TcClass } from "./types";

export interface ProfileOffsets {
	/** Log speed offset (`profile.speed`). */
	speed: number;
	/** Premove logit offset (`profile.premove`). */
	premove: number;
	/** Impulsiveness offset added to the Beta(2,2) draw. */
	iota: number;
}

export const TIMING_CONSTANTS = {
	/** Appendix D §2 feature scalings. */
	features: {
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
		bookMaxPly: 16,
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
	},
	/**
	 * Clockless games (§8.4b items 1 and 6): ONE virtual context shared by the features, the
	 * budget bypass and the ChessMimic inputs (a blitz context inside ChessMimic's training
	 * range). The clock-pressure terms and the budget controller are bypassed, which is what
	 * "classical conditioning" means here — not a long virtual base.
	 */
	untimedVirtual: { clockS: 300, incS: 0 },
	/** Appendix D §3a.2 budget controller. */
	budget: {
		nRemBase: 22,
		nRemPerPiece: 0.9,
		nRemPerPawn: 0.5,
		nRemPerMove: 0.25,
		nRemMin: 10,
		nRemMax: 45,
		reserveFraction: 0.06,
		reserveMinS: 2,
		reserveMaxS: 20,
		allocMinS: 0.15,
		allocIncWeight: 0.9,
		overspendFactor: 0.35,
		overspendPlyHorizon: 60,
		aheadOfScheduleExp: 0.1,
	},
	/** Appendix D §3a.3 body coefficients (log scale). */
	beta: {
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
	},
	/** Appendix D §3a.4 residual. */
	sigma: { base: 0.8, elo: -0.12, phaseMid: 0.1, book: -0.08, min: 0.05 },
	phi: { base: 0.35, elo: 0.05 },
	/** Appendix D §3a.3 time-pressure compression. */
	compression: {
		clockS: 30,
		pressure: 0.2,
		floor: 0.35,
		panicClockS: 12,
		panicFloor: 0.15,
		incFloorIncS: 2,
		incFloorClockS: 5,
		incFloor: 0.6,
	},
	/** Hard caps: `0.5·C`; `0.15·C` if `C < 30 && inc < 2`; `0.35 s` if `C < 3`. */
	caps: {
		fraction: 0.5,
		lowFraction: 0.15,
		lowClockS: 30,
		lowIncS: 2,
		tinyClockS: 3,
		tinyCapS: 0.35,
		/** A binding cap lands in `cap · U(jitterMin, 1)` rather than exactly at the cap (§8.4a). */
		jitterMin: 0.75,
	},
	/** Appendix D §3a.5 premove spike. */
	premove: {
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
		/** `t_premove ~ U(0, maxS)`; chess.com adds its fixed penalty. */
		maxS: 0.12,
		chesscomPenaltyS: 0.1,
	},
	/** Appendix D §3a.5 instant reply. */
	instant: {
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
	},
	/** Appendix D §3a.5 long-think tail. */
	longThink: {
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
	},
	/** Tilt: 3 moves after an own move that lost ≥ 200 cp. */
	tilt: { moves: 3, dropCp: 200, bodyIota: 0.35, instantIota: 0.6 },
	/** Hesitation fake-out (motor), `p = pBase + pElo·(1 − elo_z)`, only when `C > minClockS`. */
	fakeout: { pBase: 0.02, pElo: 0.015, holdMs: [250, 700], gapMs: [300, 900], minClockS: 20 },
	/** Appendix D §3a.6 motor model. */
	motor: {
		hoverMedianS: 0.22,
		hoverSigma: 0.35,
		dragBaseS: 0.09,
		dragLogS: 0.07,
		dragSdS: 0.03,
		dragMinS: 0.08,
		dragMaxS: 0.6,
		clickBaseS: 0.12,
		clickLogS: 0.05,
		promoS: [0.25, 0.6],
		/** Floor when `t_total < t_motor` (premove: 0). */
		minMotorMs: 60,
	},
	/** Appendix D §4 persona latents (no `session_mu`, §8.4b item 4). */
	persona: {
		sGameSigma: 0.2,
		iotaBeta: [2, 2],
		piSigma: 0.5,
		tauMean: 0.65,
		tauEloSlope: 0.2,
		tauSd: 0.12,
		mirrorRange: [0.05, 0.3],
		motorKMean: 1,
		motorKSd: 0.12,
		motorKMin: 0.4,
		/** Beta parameterisation keeps the τ mean strictly inside (0, 1). */
		tauMeanClamp: [0.05, 0.95],
		/** Appendix D §4 profiles mapped onto `PersonaId`: slow / normal / fast / blitz-specialist. */
		profiles: {
			cautious: { speed: 0.35, premove: -0.5, iota: -0.2 },
			balanced: { speed: 0, premove: 0, iota: 0 },
			aggressive: { speed: -0.35, premove: 0.5, iota: 0.2 },
			blitz: { speed: -0.35, premove: 1, iota: 0.2 },
		} as Record<PersonaId, ProfileOffsets>,
	},
	/** §8.4b item 2 orientation latency. */
	orientation: { medianMs: 380, sigma: 0.35, swingBad: 0.4, ponderHit: -0.25, minMs: 150 },
	/** §8.4b item 3 window allocation. */
	window: {
		decisionMin: 0.15,
		decisionMax: 0.4,
		/** Share of the exploration budget spent on preview selections when the window has one. */
		previewShare: 0.25,
	},
	/** §8.4a guards. */
	minNormalMs: 250,
	cvGuard: { minCv: 0.5, afterMoves: 12, maxResamples: 3 },
	/** §8.4b item 5: a bot opponent never drags us below this fraction of the model median. */
	botPaceFloor: 0.6,
	botPace: { minMoves: 3, maxReplyMs: 1500, maxCv: 0.35 },
	/** Appendix D §5 re-plan rules. */
	replan: {
		clockJumpThresholdMs: 1500,
		blurReorientS: [0.3, 1.2],
		blurPauseThresholdS: 2,
		blurMinClockS: 15,
		emergencyClockMs: 1500,
		observeShiftClamp: 2,
	},
	/** §8.4b item 6 ChessMimic head. */
	chessmimic: {
		sGameSigma: 0.2,
		arSigma: 0.2,
		arPhi: 0.35,
		temperature: 1,
		inferenceBudgetMs: 100,
		bands: ["1200_1300", "1500_1600", "1800_1900"],
		recentMoves: 12,
		fenTokens: 78,
		sequenceLength: 92,
		moveVocabSize: 1968,
		nBuckets: 30,
		/** Placeholder span of the open [40, ∞) bucket (the empirical samples cover 40–59 s). */
		openBucketSpanS: 20,
		/** The top 4 buckets (≥ 26 s, §3b.1) or `t > longMedianMultiple·median` label the sample `long`. */
		longBucketFrom: 26,
		longMedianMultiple: 6,
	},
	/** Appendix D §7: v2 MLP head (not shipped; kept for the knob table). */
	v2Mlp: { arSigma: 0.35, temperature: 1 },
	/** `Settings.timing.premoveTendency` ∈ [0,1] maps to the ±2 logit knob (Appendix D §7 knob 5). */
	knobs: { premoveNeutral: 0.5, premoveLogitSpan: 4 },
} as const;
