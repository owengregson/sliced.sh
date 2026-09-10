/**
 * Engine search-budget registry (Part I §7.5, Appendix E §4). Every number the
 * `GameSession`'s recommendation pipeline uses to size one search lives here:
 * the think→engine fraction, the per-speed depth caps, the adaptive MultiPV
 * ladder, the shallow-device quality guard and the ponder shape.
 */

/** Time-control classes the caps are keyed by (the timing model's `TcClass`). */
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
	/** `go movetime X depth D`: stop at whichever comes first, capped by `Settings.engine.depthCap`. */
	depthCap: {
		bullet: 14,
		blitz: 18,
		rapid: 22,
		classical: 24,
		untimed: 24,
	} as Readonly<Record<BudgetTcClass, number>>,
	/** `K = 3` under `multiPvSmallMs`, `6` under `multiPvMediumMs`, else `multiPvMax`. */
	multiPvSmall: 3,
	multiPvSmallMs: 300,
	multiPvMedium: 6,
	multiPvMediumMs: 1_500,
	multiPvLarge: 8,
	/** Quality guard: a result shallower than this is retried once with `retryExtraMs` more. */
	retryDepth: 8,
	retryExtraMs: 300,
	/** Below this depth the selector sees the top two lines only, with τ halved. */
	shallowDepth: 6,
	shallowLines: 2,
	shallowTauScale: 0.5,
	/** Appendix E §4.2: `go infinite` MultiPV 3 on the opponent's position. */
	ponderMultiPv: 3,
	/** Panel-only deepening on our own position while nothing is armed (§7.5). */
	panelMultiPv: 4,
} as const;
