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
} as const;

/** §7.4 premove-candidate constants (Task 15) — the single definition. */
export const PREMOVE = {
	/** Premoves only in these §8.4b time-control classes. */
	speeds: ["bullet", "blitz"] as const satisfies readonly TcClass[],
	minElo: 1200,
	/** `p = probBase + probRange·clamp((E − minElo)/probSpan, 0, 1)`. */
	probBase: 0.35,
	probRange: 0.5,
	probSpan: 1200,
	/** A recognised trade is a deliberate premove opportunity, independent of the generic reflex rate. */
	tradeProbBase: 0.98,
	tradeProbRange: 0.01,
	tradePersonaFloor: 0.99,
	tradeReplyMinProb: 0.35,
	/** A safe offer may be below the engine's first predicted reply. Bound extra reply searches. */
	tradeReplyCandidates: 3,
	fastQueueDelayMinMs: 0,
	fastQueueDelayMaxMs: 60,
	tradeQueueDelayMinMs: 80,
	tradeQueueDelayMaxMs: 220,
	/** Opponent prediction when no `ponder` move is available: `go movetime 150` MultiPV 3. */
	ponderMovetimeMs: 150,
	ponderMultiPv: 3,
	/** Reply-predictability gate: softmax temperature (win-fraction units) and threshold. */
	replyTau: 0.06,
	replyMinProb: 0.6,
	/** Analysis after `m r`: `go movetime 120` MultiPV 2. */
	replyMovetimeMs: 120,
	replyMultiPv: 2,
	/** Clear-only move: the second line loses at least this win-fraction. */
	loss2ndMin: 0.25,
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
	 * and nowhere near the end of their think — which is where a human enters one.
	 */
	queueDelayMinMs: 350,
	queueDelayMaxMs: 1200,
} as const;
