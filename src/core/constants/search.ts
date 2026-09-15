/**
 * Engine search-budget registry (Part I §7.5, Appendix E §4). Every number the
 * `GameSession`'s recommendation pipeline uses to size one search lives here:
 * the think→engine fraction, the active-Elo depth ceiling, the adaptive MultiPV
 * ladder, candidate breadth, bounded shallow retry and the ponder shape.
 */

/** Time-control classes the search-time budgets are keyed by (the timing model's `TcClass`). */
type BudgetTcClass = "bullet" | "blitz" | "rapid" | "classical" | "untimed";

export const SEARCH_BUDGET = {
	/**
	 * §6.4's per-move protocol: the own-move search budget is **plan-independent**, 400–1500 ms by
	 * speed class. It is not `0.6 · plannedThinkMs` (§7.5's formula) because that made the search
	 * as long as the wait: with a 7.5 s planned think every move ran a 4 s search before a
	 * recommendation existed at all, the panel showed nothing for that whole time, and — since the
	 * executor fits the plan into what is left of the deadline — **no move could be played faster
	 * than the search**, which truncated the left tail of `MoveHoldTime` (§13.2) at 4 s and made
	 * the model's own premove/instant modes unobservable.
	 *
	 * §7.5's requirement is that the search finish *before the hand acts* — a lower bound on the
	 * wait, not a reason to spend it — and it survives here as `thinkFraction`, one of the three
	 * bounds below. The class base binds in normal play; the §7.5 bound and the clock fraction bind
	 * in time trouble, where a shorter search is what we want anyway.
	 */
	moveMs: {
		bullet: 400,
		blitz: 600,
		rapid: 1_000,
		classical: 1_500,
		untimed: 1_500,
	} as Readonly<Record<BudgetTcClass, number>>,
	/** §7.5: the search must have finished before we act — an upper bound on the budget. */
	thinkFraction: 0.6,
	/** Never spend more than this fraction of the clock we have left on one search. */
	clockFraction: 0.05,
	minMovetimeMs: 150,
	maxMovetimeMs: 4_000,
	/** Maximum time to wait for bestmove after a move's wall-clock deadline sends stop. */
	stopReceiptMs: 50,
	/** Elo controls the depth ceiling; time-control and clock limits still bound actual search time. */
	automaticDepth: { maxSmallDepth: 28 },
	/** `K = 3` under `multiPvSmallMs`, `6` under `multiPvMediumMs`, else `multiPvMax`. */
	multiPvSmall: 3,
	multiPvSmallMs: 300,
	multiPvMedium: 6,
	multiPvMediumMs: 1_500,
	multiPvLarge: 8,
	/**
	 * Persona sampling needs alternatives beyond the engine's best few near-equal moves.
	 * These are internal candidate counts, independent of how many panel lines are shown.
	 * Keep the same wall-clock budget; stronger targets concentrate search on fewer roots.
	 */
	selectionCandidates: [
		{ maxElo: 1800, count: 20 },
		{ maxElo: 2200, count: 16 },
		{ maxElo: 2600, count: 12 },
	],
	/** Rushed sampling still needs ordinary alternatives beyond a narrow near-best native pool. */
	opponentRaceCandidates: 12,
	/**
	 * H15 (2026-09-13): the referee breadth from `MAIA.eloMax` up, when a Maia-79M prior breaks
	 * the engine's ties (`maiaPriorMode`). The native path asks for six roots there
	 * (`docs/qa/high-elo-selection-2026-09-11.md`), which leaves nothing to choose among.
	 */
	priorCandidates: 12,
	/**
	 * §7 A1 (2026-09-13): in a pool that mixes search frames (the main referee frame plus the
	 * extra `searchmoves` frame on Maia's unscored favourites), two centipawn scores within this
	 * band are a tie, and `rankedLines` breaks it towards the deeper line. Outside the band the
	 * scores order the pool — except for the reference (rank 1), which is always the main frame's
	 * best line (`compareLinesForMerge` in `src/core/strength/quality.ts`).
	 */
	mergeTieCp: 15,
	/**
	 * §7 A2 (2026-09-13): `moveQuality` accepts a chosen line whose depth differs from the
	 * reference's by at most this many plies (both at or past `quality.minDepth`) as a comparable
	 * `cpLoss` sample; further apart is `depth-mismatch`. The extra referee frame is typically one
	 * to three plies shallower than the main frame, and before this the session's §13.6
	 * diagnostics went blind on every move it enabled.
	 */
	qualityDepthTolerance: 4,
	/**
	 * Appendix E §4.5: a cached result within this many plies of the requested `depthCap` skips the
	 * search. Requiring the cap exactly meant nothing ever hit — a `movetime` search stops where it
	 * stops, so a pondered position was re-searched from scratch however deep it already was.
	 */
	cacheDepthSlack: 2,
	/** A shallower result may retry once, using only time left in its original budget. */
	retryDepth: 8,
	/** Appendix E §4.2: `go infinite` MultiPV 3 on the opponent's position. */
	ponderMultiPv: 3,
	/** Panel-only deepening on our own position while nothing is armed (§7.5). */
	panelMultiPv: 4,
} as const;

/** Comparison-depth requests share the bounded search; this is not a depth-to-Elo calibration. */
export const HUMAN_DEPTH: ReadonlyArray<readonly [elo: number, depth: number]> = [
	[800, 2],
	[1200, 4],
	[1600, 6],
	[2000, 8],
	[2400, 10],
	[2800, 10],
	[3000, 14],
];

/**
 * H5 (2026-09-13): the think time a class counts as "unhurried", in ms, for the short-think term
 * of the pipeline's context penalty — `shortThink = clamp(1 − estimatedThinkMs / ref, 0, 1)`, so
 * a move planned at or above the reference costs nothing and a move squeezed towards zero costs
 * `MAIA.context.thinkElo`. Set at the fresh-game `estimatedThinkMs` allocation measured on
 * 2026-09-13 (default persona, `speedScale` 1, ply 20): 1+0 ≈ 1.6 s, 3+0 ≈ 4.9 s, 3+2 ≈ 6.9 s,
 * 10+0 ≈ 16 s, 30+0 ≈ 50 s — rounded down so an increment game with a fuller allocation still
 * reads as unhurried. `untimed` has no clock to be short of: the term is 0 there.
 */
export const MAIA_CONTEXT_THINK_REF_MS: Readonly<Record<BudgetTcClass, number>> = {
	bullet: 1_500,
	blitz: 5_000,
	rapid: 15_000,
	classical: 30_000,
	untimed: 0,
};

/**
 * H10 / H17 (2026-09-13, `docs/research/human-move-selection-ideas-2026-09-13.md`): one
 * Maia-shaped referee search instead of a broad MultiPV search plus a second `go searchmoves`
 * on the favourites it missed. When Maia's answer for the board is in hand, the search's roots
 * are Maia's own top-k plus the engine's known best moves, every root scored in one frame at one
 * depth (`shapedRootSet` / `shapedSearchPlan` in `src/service/game-session/recommendation.ts`).
 */
export const MAIA_SEARCH = {
	shaped: {
		/** The unrestricted anchor shares the preparation budget with the final scored pool. */
		anchorMaxMs: 200,
		anchorFraction: 1 / 3,
		/** Off → today's broad search and extra-search path, byte for byte. */
		enabled: true,
		/**
		 * On our turn, how long the pipeline waits for a fresh policy answer before falling back to
		 * the broad search. The query keeps running past this for the selector; only the *shape* of
		 * the search is decided here. Sized for the 5M (≈ 20 ms) and 23M (≈ 50 ms) queries; the 79M
		 * (≈ 180–300 ms) makes it only when pre-inferred during the opponent's turn (H7.3).
		 */
		policyFirstMs: 120,
		/**
		 * On the opponent's turn, how long the pre-analysis of the predicted position waits for its
		 * pre-inference before searching broad. Longer than `policyFirstMs` because it costs only
		 * pre-analysis depth on their clock, and it has to cover the 79M query or the 2000–2600 band
		 * could never get the shaped pre-analysis that makes a correct prediction a cache hit.
		 */
		preInferWaitMs: 300,
		/** Maia's top-k roots cover at least this share of its legal-move mass. */
		massCover: 0.95,
		/** Never fewer roots than this (Maia's next-ranked moves fill), never more Maia roots than `maxRoots`. */
		minRoots: 4,
		maxRoots: 12,
		/** How many of the engine's known best moves (ponder / pre-analysis) are forced into the set. */
		knownTopMoves: 3,
		/**
		 * H17 item 2: when Maia's top move carries at least this probability the search cannot change
		 * the outcome; the movetime shrinks toward `SEARCH_BUDGET.minMovetimeMs` by
		 * `confidentTimeFraction` of the distance (never below the floor — the panel still needs an
		 * eval). Search time only; the move's planned think time is the timing model's and untouched.
		 */
		confidentProb: 0.8,
		confidentTimeFraction: 0.5,
	},
} as const;
