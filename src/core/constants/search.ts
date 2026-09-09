/**
 * Engine search-budget registry (Part I §7.5, Appendix E §4). Every number the
 * `GameSession`'s recommendation pipeline uses to size one search lives here:
 * the think→engine fraction, the per-speed depth caps, the adaptive MultiPV
 * ladder, the shallow-device quality guard and the ponder shape.
 */

/** Time-control classes the caps are keyed by (the timing model's `TcClass`). */
type BudgetTcClass = "bullet" | "blitz" | "rapid" | "classical" | "untimed";

export const SEARCH_BUDGET = {
	/** `tEngine = clamp(0.6 · plannedThinkMs, 150, 4000)` — the search must finish before we act. */
	thinkFraction: 0.6,
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
