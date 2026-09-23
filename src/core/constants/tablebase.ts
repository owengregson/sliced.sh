/**
 * Endgame tablebases (2026-09-23): positions with at most `TABLEBASE.maxPieces` men, kings
 * included, are answered by the Syzygy tables behind the Lichess tablebase API. The design and the
 * evidence behind every number below are in `docs/qa/endgame-tablebases-2026-09-23.md`.
 *
 * C1 registry: the endpoint and every number the tablebase path reads live here, once.
 */

/**
 * The Lichess tablebase HTTP API (standard chess, Syzygy 7-man, DTM for ≤ 5 men). A **separate
 * top-level export, not a `URLS` member**: a bundler inlines an object literal whole, and this host
 * belongs to the service worker alone (the only caller). `scripts/verify-dist.ts`'s `HOST_OWNERS`
 * fails the build if it reaches any other bundle — above all the page realm (§13.3).
 *
 * The server answers `Access-Control-Allow-Origin: *`, so the worker's CORS fetch needs no host
 * permission (a new host permission would disable the extension on update until re-approved).
 */
export const TABLEBASE_ENDPOINT = "https://tablebase.lichess.ovh/standard";

export const TABLEBASE = {
	/** Syzygy covers every position with at most this many men, kings included. */
	maxPieces: 7,
	/**
	 * The 50-move rule in plies: a win whose zeroing move lands after the half-move clock reaches
	 * this is a draw on chess.com, which applies the rule automatically.
	 */
	fiftyMovePlies: 100,
	/**
	 * Syzygy DTZ may be one ply too high where the table stores it rounded (`precise_dtz` null).
	 * Such a win keeps this margin from the 50-move boundary, exactly as Stockfish's root probe does.
	 */
	roundedDtzMarginPlies: 1,
	/** Upper bound on one HTTP request; the pipeline's own deadline usually ends the wait earlier. */
	timeoutMs: 2_000,
	/**
	 * At max strength the move search waits at least this long for a probe it already started,
	 * outside a clock race. The API answers in ≈ 50–300 ms, the probe starts with the move search,
	 * and a preparation overrun only eats into the planned think time (the deadline never moves).
	 */
	maxStrengthMinWaitMs: 600,
	/** Courtesy spacing between requests to the public API (one game asks at most once per move). */
	minIntervalMs: 250,
	/** HTTP 429: the API asks clients to wait a full minute before the next request. */
	rateLimitBackoffMs: 60_000,
	/** After this many consecutive failures (network, 5xx, malformed), stop asking for a while. */
	failureTripCount: 3,
	/** How long a tripped breaker keeps the tablebase off; the engine plays meanwhile. */
	failureBackoffMs: 120_000,
	/** Positions cached per service-worker lifetime (the answer does not depend on the counters). */
	cacheEntries: 512,
} as const;

/**
 * The human-rating policy (`src/core/strength/tablebase-policy.ts`): how often a player of rating
 * `E` plays the tablebase's move in a tablebase position. Evidence and decision:
 * `docs/qa/endgame-tablebases-2026-09-23.md`.
 */
export const TABLEBASE_HUMAN = {
	/** Below this effective rating the tablebase is never consulted: the human policy plays. */
	floorElo: 1600,
	/** The probability reaches `maxProb` at this effective rating. */
	fullElo: 2800,
	/** The probability at `floorElo`. */
	floorProb: 0.05,
	/** The probability from `fullElo` up (the Maia ceiling range). */
	maxProb: 0.5,
	/**
	 * Men (kings included) up to which the policy applies at its full probability; above it the
	 * probability is scaled by `largeScale` — the 6–7-man tables hold wins no human finds.
	 */
	simpleMaxPieces: 5,
	/** The probability multiplier for 6–7-man positions. */
	largeScale: 0.5,
} as const;
