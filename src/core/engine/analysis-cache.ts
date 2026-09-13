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

/** The `sm:` segment of a restricted search's key: its roots sorted, comma-joined. */
export function searchmovesKey(searchmoves: readonly string[] | undefined): string {
	return searchmoves?.length ? [...searchmoves].sort().join(",") : "";
}

/** The same root set (order-insensitive); two unrestricted searches are the same set too. */
export function sameSearchmoves(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined
): boolean {
	return searchmovesKey(a) === searchmovesKey(b);
}

/**
 * `fen|multiPv|elo|limit`, plus `|f<depth>` when the request asks for a human frame other than
 * the default `LIMITS.featureDepth` (H4, 2026-09-13) — the default keys exactly as before — and
 * `|sm:<sorted roots>` for a restricted (`searchmoves`) search (H10, 2026-09-13).
 */
export function cacheKey(
	fen: string,
	multiPv: number,
	elo: number | undefined,
	limit: AnalysisLimit,
	moves: readonly string[] = [],
	featureDepth: number = LIMITS.featureDepth,
	searchmoves?: readonly string[]
): string {
	const frame = featureDepth === LIMITS.featureDepth ? "" : `|f${featureDepth}`;
	const roots = searchmoves?.length ? `|sm:${searchmovesKey(searchmoves)}` : "";
	return `${historyKey(fen, moves)}|${multiPv}|${elo ?? "full"}|${limitKey(limit)}${frame}${roots}`;
}

/**
 * A finished or superseded request is reusable only when its final MultiPV
 * iteration completed. Request completion alone does not establish the depth
 * and candidate coverage promised by the cache key. Failed results never are.
 */
export function isCacheable(result: AnalysisResult): boolean {
	return result.final.complete && (result.status === "complete" || result.status === "superseded");
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
