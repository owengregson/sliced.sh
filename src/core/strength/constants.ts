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
		/** `f_clock = 1 + clockGain·clamp((clockPressureMs − clock)/clockPressureMs, 0, 1)`. */
		clockPressureMs: 20_000,
		clockGain: 1.5,
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
