/**
 * Own transposition cache over `LruCache` (§6.4 / Appendix E §7.1). Keyed by
 * position, reversible history, fifty-move clock, MultiPV, strength and limit.
 * Fullmove numbers do not affect identity. Stored results retain the original
 * request so a prior occurrence cannot masquerade as the current search.
 */

import { historyKey } from "@core/chess/history";
import { LIMITS } from "@core/constants/limits";
import { LruCache } from "@core/util/lru";
import { cacheKey, isCacheable, sameSearchmoves } from "./analysis-cache/keys";
import type { AnalysisResult } from "./types";

export {
	cacheKey,
	fenKey,
	isCacheable,
	limitKey,
	sameSearchmoves,
	searchmovesKey,
} from "./analysis-cache/keys";

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
	 * `minDepth <= final.depth <= maxDepth`, captured with the same human frame (`featureDepth`,
	 * default `LIMITS.featureDepth`: a result carries only the one frame it was asked for) and over
	 * the same root set (`searchmoves`, H10: a restricted result answers only the identical
	 * restriction, and an unrestricted one only an unrestricted request). A hit refreshes recency.
	 */
	get(
		fen: string,
		multiPv: number,
		minDepth: number,
		elo?: number,
		moves: readonly string[] = [],
		maxDepth = Number.POSITIVE_INFINITY,
		featureDepth: number = LIMITS.featureDepth,
		searchmoves?: readonly string[]
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
				(r.request.featureDepth ?? LIMITS.featureDepth) !== featureDepth ||
				!sameSearchmoves(r.request.searchmoves, searchmoves) ||
				r.final.depth < minDepth ||
				r.final.depth > maxDepth
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

	/**
	 * Stores only cacheable results (see `isCacheable`). A restricted (`searchmoves`) result is
	 * stored only when the request is a Maia-shaped own-move search (`shaped`, H10): it is keyed on
	 * its roots and answers only the identical restriction. Any other restricted search — the extra
	 * referee search — cannot answer an unrestricted request and is never stored.
	 */
	set(result: AnalysisResult): void {
		if (!isCacheable(result)) return;
		const { fen, moves, multiPv, elo, limit, searchmoves, featureDepth, shaped } = result.request;
		if (searchmoves?.length && shaped !== true) return;
		const fk = historyKey(fen, moves);
		if (fk === null) return;
		const key = cacheKey(fen, multiPv, elo, limit, moves, featureDepth, searchmoves);
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
