/**
 * Opening-book registry (Task 15, §7.3): the Polyglot book files bundled under
 * `assets/books/` and the policy parameters that read them. Nothing in
 * `src/core/strength/book/*` carries a numeric literal that belongs here.
 */

import type { TcClass } from "@core/timing/types";

/** Polyglot books bundled in `dir`; loaded in the SW via `runtimeGetURL(dir + name)`. */
export const BOOKS = {
	/** Both players ≥ 2600 (Lichess ratings): the `E ≥ 1800` book. */
	gm2600: "gm2600.bin",
	/** 1200–1800 club games: the book below `E = 1800`. Built by `scripts/build-club-book.py`. */
	club: "club.bin",
	dir: "assets/books/",
} as const;

export type BookName = Exclude<keyof typeof BOOKS, "dir">;

/** Opening-book policy constants (§7.3, Appendix E §2.2–§2.3). */
export const BOOK = {
	/** `γ(E) = base + range·clamp((E − eloFloor)/eloSpan, 0, 1)`. */
	gamma: { base: 0.75, range: 0.25, eloFloor: 1200, eloSpan: 1200 },
	/** From this E a sampled move losing ≥ `trapLoss` win-fraction vs the engine's best is refused. */
	trapCheckElo: 1800,
	trapLoss: 0.15,
	/** Book play stops after this ply (§7.3). */
	maxPly: 30,
	/** Keep moves with `weight ≥ minWeightShare·Σweight` (Appendix E §2.3). */
	minWeightShare: 0.01,
	/** Appendix E §2.2: below `weakElo` leave the book early with this probability per move. */
	weakLeaveProb: 0.05,
	weakElo: 1400,
	/** `gm2600` from this E, `club` below (§7.3 item 2). */
	gmBookElo: 1800,
	/**
	 * H14.2 (2026-09-13, `docs/research/human-move-selection-ideas-2026-09-13.md`): below this
	 * effective E, when Maia selects and its answer arrived, the book does not answer — Maia is
	 * trained on exactly the population's openings at that rating and conditions on it, whereas
	 * the book weights master-game frequency an 800 has never seen. From here up the book keeps
	 * playing "theory the player has studied". The engine-fallback move (no answer in budget)
	 * keeps the book.
	 */
	maiaOnlyElo: 1700,
	/**
	 * H14.2's timing half: with the book suppressed, a move at or under `maxPly` that Maia gives
	 * at least this probability still counts as `in_book` for the timing model, so the memorised-
	 * opening speed-up (`TIMING_CONSTANTS.bookSpeed`) is unchanged in behaviour. A timing-owner flag;
	 * the timing model itself is untouched.
	 */
	maiaOpeningMinProb: 0.3,
} as const;

/** §7.4 premove-candidate constants (Task 15) — the single definition. */
export const PREMOVE = {
	/** Premoves only in these §8.4b time-control classes. */
	speeds: ["bullet", "blitz"] as const satisfies readonly TcClass[],
	minElo: 1200,
	/**
	 * `p = probBase + probRange·clamp((E − minElo)/probSpan, 0, 1)`. Raised on 2026-09-11 (owner:
	 * "not premoving expected premoves often enough"): 0.55 → 0.95 across the Elo span, from
	 * 0.35 → 0.85.
	 */
	probBase: 0.55,
	probRange: 0.4,
	probSpan: 1200,
	/** A recognised trade is a deliberate premove opportunity, independent of the generic reflex rate. */
	tradeProbBase: 0.98,
	tradeProbRange: 0.01,
	tradePersonaFloor: 0.99,
	fastQueueDelayMinMs: 0,
	fastQueueDelayMaxMs: 60,
	tradeQueueDelayMinMs: 80,
	tradeQueueDelayMaxMs: 220,
	/** Stop re-queueing the same move after this many consecutive avoided, completed attempts. */
	maxIgnoredQueueAttempts: 2,
	/**
	 * Opponent prediction when no `ponder` move is available: `go movetime 220` MultiPV 3 — long
	 * enough for `replyMinAlternatives` roots to reach `replyMinDepth` in the usual case.
	 */
	ponderMovetimeMs: 220,
	ponderMultiPv: 3,
	/**
	 * Reply-predictability gate: softmax temperature (win-fraction units) and threshold. 0.55 lets
	 * a clear favourite through against two live alternatives but still refuses a coin flip
	 * between near-equals; 0.6 needed a near-forced reply.
	 */
	replyTau: 0.06,
	replyMinProb: 0.55,
	/** Require distinct, sufficiently searched alternatives before interpreting confidence. */
	replyMinAlternatives: 2,
	replyMinDepth: 4,
	/** Raw scores still gate quality when win fractions saturate in won/lost positions. */
	replyMaxCpLoss: 45,
	/** An unforced predicted exchange may not donate more than one pawn without a takeback. */
	tradeMaxMaterialLoss: 1,
	/** Analysis after `m r`: `go movetime 120` MultiPV 2. */
	replyMovetimeMs: 120,
	replyMultiPv: 2,
	/** Clear-only move: the second line loses at least this win-fraction. */
	loss2ndMin: 0.18,
	/**
	 * Reasons eligible for a site queue. Eligibility alone is insufficient: isQueueableCandidate
	 * validates the occupied destination and all other legal replies. An only-move block can
	 * remain legal after a different reply, so it must not be assumed safe from its reason alone.
	 * Clear-best quiet moves remain fast replies after the expected position actually arrives.
	 */
	queueReasons: ["recapture", "only-move", "king-escape"] as const,
	/**
	 * When the premove is entered, measured from the position it is premoved from appearing:
	 * `U(queueDelayMinMs, queueDelayMaxMs)`. Not instant (a reflex on the opponent's move landing)
	 * and nowhere near the end of their think — which is where a human enters one. The clock
	 * starts after the two arming searches (~340 ms), so a longer window mostly meant the opponent
	 * had already replied by the time the entry was due.
	 */
	queueDelayMinMs: 150,
	queueDelayMaxMs: 700,
	/**
	 * H8 (2026-09-13): Maia as the premove *gate*, never the chooser. When the session already
	 * holds the human policy's answer for the predicted position (the H7.3 pre-inference), a
	 * premove is armed only if the model gives it at least this much mass there — a human
	 * premoves a move they would have played anyway. Without an answer for that position the
	 * engine/heuristic construction above decides alone, exactly as before.
	 */
	maiaMinProb: 0.15,
} as const;
