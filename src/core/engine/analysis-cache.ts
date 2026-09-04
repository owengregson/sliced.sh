/**
 * Own transposition cache over `LruCache` (§6.4 / Appendix E §7.1). Keyed by
 * `${fenKey}|${multiPv}|${elo}|${limitKey}`; the FEN key drops the
 * halfmove/fullmove fields (evaluations do not depend on them), the stored
 * result keeps the full request. Ponder results are inserted at full strength
 * so the opponent's expected reply is often a hit for the panel.
 */

import { LIMITS } from "@core/constants/limits";
import { LruCache } from "@core/util/lru";
import type { AnalysisLimit, AnalysisResult } from "./types";

/** First four FEN fields (placement, turn, castling, en passant). */
export function fenKey(fen: string): string {
	return fen.trim().split(/\s+/).slice(0, 4).join(" ");
}

/** `inf` | `d<depth>[t<ms>]` | `t<ms>` | `n<nodes>`; `t` alone is the default movetime. */
export function limitKey(limit: AnalysisLimit): string {
	if (limit.infinite) return "inf";
	if (limit.nodes !== undefined) return `n${limit.nodes}`;
	const depth = limit.depth !== undefined ? `d${limit.depth}` : "";
	const time = limit.movetimeMs !== undefined ? `t${limit.movetimeMs}` : "";
	return depth !== "" && time === "" ? depth : `${depth}t${limit.movetimeMs ?? ""}`;
}

export function cacheKey(
	fen: string,
	multiPv: number,
	elo: number | undefined,
	limit: AnalysisLimit
): string {
	return `${fenKey(fen)}|${multiPv}|${elo ?? "full"}|${limitKey(limit)}`;
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
	 * The deepest complete result for `fen` searched with `multiPv` lines or
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
				r.status !== "complete" ||
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

	/** Only complete results are stored. */
	set(result: AnalysisResult): void {
		if (result.status !== "complete") return;
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
