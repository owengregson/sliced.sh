/**
 * Opening-book registry (Task 15, §7.3): the Polyglot book files bundled under
 * `assets/books/` and every Lichess opening-explorer parameter. Nothing in
 * `src/core/strength/book/*` carries a numeric literal that belongs here.
 */

/** Polyglot books bundled in `dir`; loaded in the SW via `runtimeGetURL(dir + name)`. */
export const BOOKS = {
	/** Both players ≥ 2600 (Lichess ratings): the `E ≥ 1800` book. */
	gm2600: "gm2600.bin",
	/** 1200–1800 club games: the book below `E = 1800`. Built by `scripts/build-club-book.py`. */
	club: "club.bin",
	dir: "assets/books/",
} as const;

export type BookName = Exclude<keyof typeof BOOKS, "dir">;

/** Lichess explorer `speeds` values, fastest first (Appendix E §2.1). */
export const EXPLORER_SPEEDS = ["ultraBullet", "bullet", "blitz", "rapid", "classical"] as const;
export type ExplorerSpeed = (typeof EXPLORER_SPEEDS)[number];

/** Lichess opening-explorer policy constants (§7.3 item 1, Appendix E §2.1). */
export const EXPLORER = {
	/** `ratings` groups accepted by the explorer; each runs up to the next. */
	ratingBuckets: [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500] as const,
	/** `ratings = [bucket(E − span), bucket(E), bucket(E + span)]`, deduped. */
	bucketSpanElo: 200,
	/** Lichess speed classification: estimated total seconds `base + incrementWeight·inc`. */
	incrementWeight: 40,
	/** Upper bounds (exclusive, seconds) for every speed but the last (`classical`). */
	speedUpperBoundsSec: [30, 180, 480, 1500] as const,
	/** `moves` query parameter (top moves returned). */
	moves: 12,
	/** `γ(E) = base + range·clamp((E − eloFloor)/eloSpan, 0, 1)`. */
	gamma: { base: 0.75, range: 0.25, eloFloor: 1200, eloSpan: 1200 },
	/** Keep moves with `n_i ≥ max(minMoveCount, minMoveShare·N)`. */
	minMoveCount: 5,
	minMoveShare: 0.02,
	/** Leave the explorer when the position has fewer games than this. */
	minPositionGames: 200,
	/** From this E a sampled move losing ≥ `trapLoss` win-fraction vs the engine's best is refused. */
	trapCheckElo: 1800,
	trapLoss: 0.15,
	/** Book play stops after this ply (§7.3). */
	maxPly: 30,
	/** HTTP 429 → no requests for this long. */
	backoffMs: 60_000,
	/** `LOCAL_KEYS.explorerCache`: TTL and LRU capacity. */
	cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
	cacheEntries: 2000,
	/** Polyglot fallback: keep moves with `weight ≥ minWeightShare·Σweight` (Appendix E §2.3). */
	polyglotMinWeightShare: 0.01,
	/** Appendix E §2.2: below `weakElo` leave the book early with this probability per move. */
	polyglotWeakLeaveProb: 0.05,
	polyglotWeakElo: 1400,
	/** `gm2600` from this E, `club` below (§7.3 item 2). */
	gmBookElo: 1800,
} as const;
