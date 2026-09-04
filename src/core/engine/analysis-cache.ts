/**
 * Own transposition cache over `LruCache` (§6.4 / Appendix E §7.1). Keyed by
 * `${fenKey}|${multiPv}|${elo}|${limitKey}`; the FEN key drops the
 * halfmove/fullmove fields (evaluations do not depend on them), the stored
 * result keeps the full request. Ponder results are inserted at full strength
 * so the opponent's expected reply is often a hit for the panel.
 */

import { LIMITS } from "@core/constants/limits";
import { TIMINGS } from "@core/constants/timings";
import { LruCache } from "@core/util/lru";
import type { AnalysisLimit, AnalysisResult } from "./types";

/** First four FEN fields (placement, turn, castling, en passant). */
export function fenKey(fen: string): string {
	return fen.trim().split(/\s+/).slice(0, 4).join(" ");
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
	limit: AnalysisLimit
): string {
	return `${fenKey(fen)}|${multiPv}|${elo ?? "full"}|${limitKey(limit)}`;
}

/**
 * A result is cacheable when it ended normally or was superseded (a ponder
 * cancelled by the next `analyse` is the common case) AND its final depth
 * iteration completed — never a failed or partial-iteration result.
 */
export function isCacheable(result: AnalysisResult): boolean {
	return (result.status === "complete" || result.status === "superseded") && result.final.complete;
}

export class AnalysisCache {
	private readonly lru: LruCache<string, AnalysisResult>;
	/** fenKey → cache keys stored under it; stale keys are pruned lazily. */
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
	get(fen: string, multiPv: number, minDepth: number, elo?: number): AnalysisResult | undefined {
		const keys = this.byFen.get(fenKey(fen));
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
		if (keys.size === 0) this.byFen.delete(fenKey(fen));
		if (bestKey !== undefined) this.lru.get(bestKey);
		return best;
	}

	/** Stores only cacheable results (see `isCacheable`). */
	set(result: AnalysisResult): void {
		if (!isCacheable(result)) return;
		const { fen, multiPv, elo, limit } = result.request;
		const fk = fenKey(fen);
		const key = cacheKey(fen, multiPv, elo, limit);
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
