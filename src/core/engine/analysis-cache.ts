/**
 * Own transposition cache over `LruCache` (§6.4 / Appendix E §7.1). Keyed by
 * position, reversible history, fifty-move clock, MultiPV, strength and limit.
 * Fullmove numbers do not affect identity. Stored results retain the original
 * request so a prior occurrence cannot masquerade as the current search.
 */

import { historyKey, positionKey } from "@core/chess/history";
import { LIMITS } from "@core/constants/limits";
import { TIMINGS } from "@core/constants/timings";
import { LruCache } from "@core/util/lru";
import type { AnalysisLimit, AnalysisResult } from "./types";

/**
 * First four FEN fields (placement, turn, castling, en passant) of the
 * **canonical** spelling of the position.
 *
 * The canonicalisation matters because three sources produce FENs for the same
 * position and they disagree on the en-passant field: chess.com's
 * `game.getFEN()` names the square after any double push, a chess.js replay
 * (`applyMoves`, which is how a ponder / premove result is keyed under the
 * position it reaches) names it only when a pawn can actually capture there, and
 * a DOM reconstruction (`approximateFen`) names it only when it can infer the
 * last move. Keyed raw, the ponder → own-move handoff therefore missed the cache
 * on every double push — silently, because a miss is just a slower move.
 *
 * `loadPosition(fen).fen()` is chess.js's own normalisation: it drops an
 * en-passant square no pawn can use and keeps one that a pawn can, so the two
 * spellings of one position collapse while two genuinely different positions
 * (one of which allows the capture) stay apart. An unparsable FEN keys on its
 * own raw fields, as before.
 */
export function fenKey(fen: string): string {
	return positionKey(fen);
}

/**
 * `inf`, else the concatenation of `d<depth>`, `t<ms>`, `n<nodes>` for the
 * fields present; an empty limit keys as the explicit default movetime the
 * client sends (`t${TIMINGS.analysisDefaultMovetimeMs}`).
 */
export function limitKey(limit: AnalysisLimit): string {
	if (limit.infinite) return "inf";
	let key = "";
	if (limit.depth !== undefined) key += `d${limit.depth}`;
	if (limit.movetimeMs !== undefined) key += `t${limit.movetimeMs}`;
	if (limit.nodes !== undefined) key += `n${limit.nodes}`;
	return key === "" ? `t${TIMINGS.analysisDefaultMovetimeMs}` : key;
}

export function cacheKey(
	fen: string,
	multiPv: number,
	elo: number | undefined,
	limit: AnalysisLimit,
	moves: readonly string[] = []
): string {
	return `${historyKey(fen, moves)}|${multiPv}|${elo ?? "full"}|${limitKey(limit)}`;
}

/**
 * Every `complete` result is cacheable (a movetime search that stopped
 * mid-iteration still carries the best lines so far; `get`'s `minDepth` is the
 * quality gate). A `superseded` result (a ponder cancelled by the next
 * `analyse` is the common case) is cacheable only when its final depth
 * iteration completed. Failed results never are.
 */
export function isCacheable(result: AnalysisResult): boolean {
	if (result.status === "complete") return true;
	return result.status === "superseded" && result.final.complete;
}

export class AnalysisCache {
	private readonly lru: LruCache<string, AnalysisResult>;
	/** History-aware position key → cache keys; stale entries are pruned lazily. */
	private readonly byFen = new Map<string, Set<string>>();

	constructor(private readonly capacity: number = LIMITS.analysisCacheEntries) {
		this.lru = new LruCache(capacity);
	}

	get size(): number {
		return this.lru.size;
	}

	/**
	 * The deepest cacheable result for `fen` searched with `multiPv` lines or
	 * more at the same strength (`elo` undefined = full strength) and
	 * `final.depth >= minDepth`. A hit refreshes recency.
	 */
	get(
		fen: string,
		multiPv: number,
		minDepth: number,
		elo?: number,
		moves: readonly string[] = []
	): AnalysisResult | undefined {
		const fk = historyKey(fen, moves);
		if (fk === null) return undefined;
		const keys = this.byFen.get(fk);
		if (!keys) return undefined;
		let bestKey: string | undefined;
		let best: AnalysisResult | undefined;
		for (const key of keys) {
			const r = this.lru.peek(key);
			if (!r) {
				keys.delete(key);
				continue;
			}
			if (
				!isCacheable(r) ||
				r.request.multiPv < multiPv ||
				r.request.elo !== elo ||
				r.final.depth < minDepth
			)
				continue;
			if (!best || r.final.depth > best.final.depth) {
				best = r;
				bestKey = key;
			}
		}
		if (keys.size === 0) this.byFen.delete(fk);
		if (bestKey !== undefined) this.lru.get(bestKey);
		return best;
	}

	/** Stores only cacheable results (see `isCacheable`). */
	set(result: AnalysisResult): void {
		if (!isCacheable(result)) return;
		const { fen, moves, multiPv, elo, limit, searchmoves } = result.request;
		// A restricted search cannot answer an unrestricted request.
		if (searchmoves?.length) return;
		const fk = historyKey(fen, moves);
		if (fk === null) return;
		const key = cacheKey(fen, multiPv, elo, limit, moves);
		this.lru.set(key, result);
		let keys = this.byFen.get(fk);
		if (!keys) {
			keys = new Set();
			this.byFen.set(fk, keys);
		}
		keys.add(key);
		if (this.byFen.size > this.capacity * 2) this.pruneIndex();
	}

	clear(): void {
		this.lru.clear();
		this.byFen.clear();
	}

	private pruneIndex(): void {
		for (const [fk, keys] of this.byFen) {
			for (const key of keys) if (!this.lru.has(key)) keys.delete(key);
			if (keys.size === 0) this.byFen.delete(fk);
		}
	}
}
