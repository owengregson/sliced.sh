/**
 * Rating-parameterised selection constants — the ONLY place the §7.2 tables
 * and the Appendix E §3.3/§3.4 prior multipliers live (Task 14). Every value is
 * transcribed from Part I §7.2 (normative) or Appendix E Part A (reference);
 * where the two disagree §7.2 wins.
 */

/** Deep-freeze helper (arrays and nested objects included). */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const key of Object.getOwnPropertyNames(value)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
		Object.freeze(value);
	}
	return value;
}

export const SELECTION_CONSTANTS = deepFreeze({
	/** §7.2 inputs: `form_t = ar·form_{t−1} + N(0, noiseSigma)`, clamped ±clampAbs; `E = target + eloPerUnit·form`. */
	form: { ar: 0.85, noiseSigma: 0.25, clampAbs: 1, eloPerUnit: 150 },
	/** §7.2 steps 2 and 4: mate → ±(mateCpBase + (mateHorizon − |mate|)); `win(cp) = 1/(1 + e^(−winProbK·cp))`. */
	score: { mateCpBase: 1000, mateHorizon: 100, winProbK: 0.00368208 },
	/** §7.2 step 3: `σ(E) = base + range·clamp((pivotElo − E)/span, 0, 1)` cp. */
	sigma: { base: 8, range: 42, pivotElo: 2400, span: 1600 },
	/** §7.2 step 7: `τ(E) = clamp(base + range·((pivotElo − E)/span)², min, max)`; ×streakMultiplier after streakLength top-1 picks. */
	tau: {
		base: 0.02,
		range: 0.28,
		pivotElo: 2500,
		span: 1700,
		min: 0.02,
		max: 0.3,
		streakLength: 12,
		streakMultiplier: 1.3,
	},
	/** §7.2 step 7: `G(E) = base + range·clamp((pivotElo − E)/span, 0, 1)` cp. */
	gap: { base: 60, range: 440, pivotElo: 2200, span: 1400 },
	/** §7.2 step 7: β(E) = 0.6 below 1600, 0.4 below 2200, else 0.2. */
	beta: { bands: [1600, 2200] as const, values: [0.6, 0.4, 0.2] as const },
	/** §7.2 step 6 / Appendix E §1.5 blunder injection. */
	blunder: {
		/** `[E, b0]` knots; flat outside, linear between. */
		b0: [
			[1000, 0.075],
			[1200, 0.055],
			[1400, 0.04],
			[1600, 0.028],
			[1800, 0.02],
			[2000, 0.013],
			[2200, 0.009],
			[2500, 0.005],
		] as const,
		/**
		 * `f_clock = 1 + clockGain·clamp((clockPressureMs − clock)/clockPressureMs, 0, 1)` — an
		 * **absolute** 20 s, so on its own the injected-error rate is flat from 3:00 down to 0:20 of a
		 * 3+0 game and only moves in the last seconds. 20 s is a third of a 1+0 game and 3 % of a 10+0,
		 * which is why `clockPressureFraction` below exists.
		 *
		 * NOT dead, and worth saying because `clockPressureFraction` dominates it in the common case.
		 * `clockFactor` takes the larger of the two, and the absolute term is the binding one in exactly
		 * two regimes (measured):
		 *
		 *   1. **no base clock is known** — an untimed game, or the §4.3 window before the page answers
		 *      `timeControl.get()`. The relative term is 0 there and this is the whole curve;
		 *   2. **ultrabullet**, where `clockPressureFraction · base < clockPressureMs`. At base ≤ 20 s
		 *      the absolute term is larger at 8–9 of 10 clock points (base 10 s: 9/10; 15 s: 9/10;
		 *      20 s: 8/10; 25 s and above: 0/10).
		 *
		 * Both are pinned in `test/core/strength/blunder-clock.test.ts`.
		 */
		clockPressureMs: 20_000,
		clockGain: 1.5,
		/**
		 * The same ramp expressed as a fraction of the game's **own** base clock (fix C step 4, the
		 * owner's live 3+0 report: "as the time gets towards the end, play should get worse"). At or
		 * above this fraction of the base clock `f_clock` is 1; below it, it climbs linearly to the
		 * same `1 + clockGain` ceiling at an empty clock, so this widens *where* the existing
		 * injection ramps without adding a failure mode or a new ceiling.
		 *
		 * Taken as a `max` with the absolute term above, never as a replacement: the late-game rate
		 * the §7.2 tests and the §13.2 runs measure can only ever go up, and a game whose base clock
		 * is unknown (untimed, or a time control the page has not answered yet) keeps exactly the
		 * absolute curve.
		 */
		clockPressureFraction: 0.8,
		/** `f_complexity = 1 + complexityGain·[std(cpEff) ≥ complexityStdCp]`. */
		complexityGain: 0.6,
		complexityStdCp: 150,
		/** 65 % mistakes in U(0.10, 0.30), 35 % blunders in U(0.30, 0.70). */
		mistakeProb: 0.65,
		mistakeLoss: [0.1, 0.3] as const,
		blunderLoss: [0.3, 0.7] as const,
		/** Only candidates with `loss ≥ minLoss` can be injected. */
		minLoss: 0.1,
		/** Prior floor in the nearest-loss weighting. */
		priorFloor: 0.02,
		/** Streak damper: `b ×= damperMultiplier` for `damperMoves` moves after an injected blunder. */
		damperMoves: 3,
		damperMultiplier: 0.3,
	},
	/** §7.2 step 5 / Appendix E §1.5 never-play rules. */
	neverPlay: {
		/** Below this E a mated line ≥ `matedMinDepth` deep may be allowed with `matedAllowProb`. */
		matedAllowBelowElo: 1000,
		matedAllowProb: 0.25,
		matedMinDepth: 2,
		/** Play mate-in-≤ `mateInMax` with p = 1 for E ≥ `mateAlwaysElo`, else `mateProbBase + mateProbBase·(E − mateProbEloFloor)/mateProbEloSpan`. */
		mateInMax: 3,
		mateAlwaysElo: 1400,
		mateProbBase: 0.5,
		mateProbEloFloor: 800,
		mateProbEloSpan: 600,
		/** When a mate is declined, lines that throw the win (loss ≥) are still excluded. */
		throwWinLoss: 0.4,
		/** Never hang a piece for nothing: PV shows an opponent capture and loss ≥. */
		hangPieceLoss: 0.25,
	},
	/** §7.1 / §7.2 step 8: `prior(bestmove) ×= 2.0` in hybrid mode. */
	hybridBestmovePrior: 2,
	/** Prior floor inside the base policy weights. */
	basePriorFloor: 1e-3,
	/** Appendix E §3.4 heuristic prior table (multiplicative on 1.0). */
	prior: {
		recapture: 2.5,
		checkWeak: 1.4,
		checkStrong: 1.15,
		checkElo: 1400,
		captureUndefended: 1.8,
		castling: 1.6,
		castlingMaxPly: 30,
		development: 1.4,
		developmentMaxPly: 20,
		kingShieldPawnPush: 0.6,
		quietKingMove: 0.35,
		rookLift: 0.7,
		retreat: 0.6,
		retreatMaxPly: 25,
		waitingMoveWeak: 0.7,
		waitingMoveWeakElo: 1600,
		waitingMoveStrongElo: 2000,
		underpromotion: 0.05,
		sacrificeWeak: 0.5,
		sacrificeWeakElo: 1800,
		sacrificeStrong: 0.9,
		sacrificeStrongElo: 2200,
		/** Material (pawns) we must be down, for ≥ `sacrificePlies` consecutive PV plies. */
		sacrificeMaterial: 2,
		sacrificePlies: 3,
		sacrificePvWindow: 8,
		backAndForth: 0.5,
		/** Own moves remembered in `SelectionState.previousOwnMoves` for the back-and-forth row. */
		previousOwnMovesKept: 4,
		kingActivation: 1.5,
		kingActivationElo: 1600,
		kingActivationMinPly: 60,
	},
	/** Appendix E §3.5 endgame technique by Elo (§7.2 step 8 situational modifier). */
	endgame: {
		/** Below `weakElo`: τ ×`weakTau` in endgames; from `strongElo`: τ ×`strongTau`. */
		weakElo: 1200,
		weakTau: 1.5,
		strongElo: 1800,
		strongTau: 0.7,
		/** "Won endgame": best raw cpEff ≥ `wonCp` with no queens on the board. */
		wonCp: 500,
		/** Pawn pushes / king moves keeping raw loss ≤ `wonLossMax` are preferred … */
		wonLossMax: 0.05,
		/** … by this prior multiplier. Design constant: Appendix E §3.5 gives the rule but no number. */
		wonTechnique: 1.5,
	},
	/** Appendix E §3.3 simplify-when-ahead / complicate-when-behind. */
	situational: {
		aheadCp: 300,
		behindCp: -300,
		tradeWhenAhead: 1.8,
		quietSharpWhenAhead: 0.7,
		forcingWhenBehind: 1.4,
		tradeWhenBehind: 0.6,
		/** Applied fully from this E; below, only "trade when ahead". */
		fullElo: 1400,
		/** A line is sharp when the PV contains ≥ this many opponent captures. */
		sharpOpponentCaptures: 2,
	},
});

export type SelectionConstants = typeof SELECTION_CONSTANTS;

/**
 * Appendix E §1.6 target whole-game statistics — the acceptance band the Live view's session
 * strip reports against (Part I §13.6: "running top-1 % and ACPL against the §7.2 band for the
 * derived target; warns after three consecutive out-of-band games"). Knots by target Elo;
 * flat outside, the nearest knot at or below the target between them.
 */
export const AGREEMENT_BANDS = deepFreeze([
	{ elo: 800, top1: [38, 45], acpl: [100, 130] },
	{ elo: 1200, top1: [42, 48], acpl: [75, 95] },
	{ elo: 1600, top1: [47, 53], acpl: [45, 60] },
	{ elo: 2000, top1: [52, 58], acpl: [28, 40] },
	{ elo: 2400, top1: [58, 66], acpl: [15, 25] },
	{ elo: 2800, top1: [68, 75], acpl: [8, 15] },
] as const);

export type AgreementBand = (typeof AGREEMENT_BANDS)[number];
