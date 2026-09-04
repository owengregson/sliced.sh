/**
 * Lichess opening-explorer client and frequency sampler (Task 15, §7.3 item 1,
 * Appendix E §2.1). `ExplorerClient` keeps one request in flight, aborts after
 * `TIMINGS.explorerTimeoutMs`, backs off for `EXPLORER.backoffMs` after a 429,
 * and caches responses under `LOCAL_KEYS.explorerCache` (30-day TTL, LRU).
 * `fetch`, the clock and the storage are injectable for tests.
 */

import { chromeLocalGet, chromeLocalSet } from "@core/chrome/storage";
import { EXPLORER, EXPLORER_SPEEDS, type ExplorerSpeed } from "@core/constants/books";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TIMINGS } from "@core/constants/timings";
import { URLS } from "@core/constants/urls";
import { log } from "@core/logger";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { LruCache } from "@core/util/lru";
import type { TimeControl } from "@typedefs/game";

export interface ExplorerMove {
	uci: string;
	san: string;
	white: number;
	draws: number;
	black: number;
	averageRating?: number;
}

export interface ExplorerResponse {
	white: number;
	draws: number;
	black: number;
	moves: ExplorerMove[];
	opening?: { eco: string; name: string } | null;
}

export interface ExplorerCacheEntry {
	/** `now()` when stored. */
	at: number;
	data: ExplorerResponse;
}

/** `LOCAL_KEYS.explorerCache` value: keyed by `ExplorerClient.cacheKey`. */
export type ExplorerCacheStore = Record<string, ExplorerCacheEntry>;

/** The part of the client the book policy depends on. */
export interface ExplorerQuery {
	query(
		fen: string,
		E: number,
		timeControl: TimeControl | undefined
	): Promise<ExplorerResponse | null>;
}

export interface ExplorerStorage {
	get(): Promise<ExplorerCacheStore | null>;
	set(store: ExplorerCacheStore): Promise<void>;
}

/** The subset of `fetch` the client uses (injectable; Bun's `typeof fetch` carries extras). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ExplorerClientDeps {
	fetch?: FetchLike;
	now?: () => number;
	storage?: ExplorerStorage;
	/** Defaults to `AbortSignal.timeout`; injectable so tests need not wait 1.2 s. */
	timeoutSignal?: (ms: number) => AbortSignal;
}

/** Nearest explorer rating group to `elo` (ties round up). */
function nearestBucket(elo: number): number {
	let best: number = EXPLORER.ratingBuckets[0];
	let bestDist = Number.POSITIVE_INFINITY;
	for (const bucket of EXPLORER.ratingBuckets) {
		const dist = Math.abs(bucket - elo);
		if (dist < bestDist || (dist === bestDist && bucket > best)) {
			best = bucket;
			bestDist = dist;
		}
	}
	return best;
}

/** `ratings = [bucket(E − 200), bucket(E), bucket(E + 200)]`, deduped and ascending. */
export function ratingsFor(E: number): number[] {
	const span = EXPLORER.bucketSpanElo;
	const out = new Set([nearestBucket(E - span), nearestBucket(E), nearestBucket(E + span)]);
	return [...out].sort((a, b) => a - b);
}

/** Lichess speed class of a time control (`base + 40·inc` seconds); blitz when unknown. */
export function speedFor(timeControl: TimeControl | undefined): ExplorerSpeed {
	if (!timeControl) return "blitz";
	const estimatedSec = (timeControl.baseMs + EXPLORER.incrementWeight * timeControl.incMs) / 1000;
	for (let i = 0; i < EXPLORER.speedUpperBoundsSec.length; i++) {
		const bound = EXPLORER.speedUpperBoundsSec[i];
		const speed = EXPLORER_SPEEDS[i];
		if (bound !== undefined && speed !== undefined && estimatedSec < bound) return speed;
	}
	return EXPLORER_SPEEDS[EXPLORER_SPEEDS.length - 1] ?? "classical";
}

/** The matching speed plus its slower neighbour (the faster one for classical). */
export function speedsFor(timeControl: TimeControl | undefined): ExplorerSpeed[] {
	const speed = speedFor(timeControl);
	const index = EXPLORER_SPEEDS.indexOf(speed);
	const neighbour =
		EXPLORER_SPEEDS[index + 1] ?? EXPLORER_SPEEDS[index - 1] ?? EXPLORER_SPEEDS[index];
	return neighbour === undefined || neighbour === speed
		? [speed]
		: [speed, neighbour].sort((a, b) => EXPLORER_SPEEDS.indexOf(a) - EXPLORER_SPEEDS.indexOf(b));
}

/** The documented GET URL (Appendix E §2.1); lists are comma-separated, the FEN is URL-encoded. */
export function explorerUrl(fen: string, E: number, timeControl: TimeControl | undefined): string {
	const query = [
		"variant=standard",
		`fen=${encodeURIComponent(fen)}`,
		`speeds=${speedsFor(timeControl).join(",")}`,
		`ratings=${ratingsFor(E).join(",")}`,
		`moves=${EXPLORER.moves}`,
		"topGames=0",
		"recentGames=0",
	];
	return `${URLS.lichessExplorer}?${query.join("&")}`;
}

/** `γ(E) = 0.75 + 0.25·clamp((E − 1200)/1200, 0, 1)`: weaker targets sample flatter. */
export function gammaFor(E: number): number {
	const { base, range, eloFloor, eloSpan } = EXPLORER.gamma;
	return base + range * clamp((E - eloFloor) / eloSpan, 0, 1);
}

export function gamesOf(move: Pick<ExplorerMove, "white" | "draws" | "black">): number {
	return move.white + move.draws + move.black;
}

/**
 * Sample one item with `p ∝ n^γ(E)` among those passing `keep`; `null` when
 * nothing survives. Shared by the explorer and polyglot samplers.
 */
export function sampleByFrequency<T>(
	items: readonly T[],
	countOf: (item: T) => number,
	keep: (count: number, total: number) => boolean,
	E: number,
	rng: Rng
): T | null {
	let total = 0;
	for (const item of items) total += countOf(item);
	const gamma = gammaFor(E);
	const kept: T[] = [];
	const weights: number[] = [];
	for (const item of items) {
		const n = countOf(item);
		if (n <= 0 || !keep(n, total)) continue;
		kept.push(item);
		weights.push(n ** gamma);
	}
	if (kept.length === 0) return null;
	return rng.weighted(kept, weights);
}

/** §7.3: keep `n_i ≥ max(5, 0.02·N)`, sample `p_i ∝ n_i^γ(E)`. */
export function sampleBookMove(
	entries: readonly ExplorerMove[],
	E: number,
	rng: Rng
): ExplorerMove | null {
	return sampleByFrequency(
		entries,
		gamesOf,
		(n, total) => n >= Math.max(EXPLORER.minMoveCount, EXPLORER.minMoveShare * total),
		E,
		rng
	);
}

function isExplorerMove(value: unknown): value is ExplorerMove {
	if (typeof value !== "object" || value === null) return false;
	const m = value as Record<string, unknown>;
	return (
		typeof m.uci === "string" &&
		typeof m.san === "string" &&
		typeof m.white === "number" &&
		typeof m.draws === "number" &&
		typeof m.black === "number"
	);
}

/** Narrow a parsed JSON body to the fields the policy reads. */
export function parseExplorerResponse(value: unknown): ExplorerResponse | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as Record<string, unknown>;
	if (typeof r.white !== "number" || typeof r.draws !== "number" || typeof r.black !== "number")
		return null;
	if (!Array.isArray(r.moves) || !r.moves.every(isExplorerMove)) return null;
	const moves: ExplorerMove[] = r.moves.map((m) => {
		const move: ExplorerMove = {
			uci: m.uci,
			san: m.san,
			white: m.white,
			draws: m.draws,
			black: m.black,
		};
		if (typeof m.averageRating === "number") move.averageRating = m.averageRating;
		return move;
	});
	const opening = r.opening;
	const out: ExplorerResponse = { white: r.white, draws: r.draws, black: r.black, moves };
	if (
		typeof opening === "object" &&
		opening !== null &&
		typeof (opening as Record<string, unknown>).eco === "string" &&
		typeof (opening as Record<string, unknown>).name === "string"
	) {
		const o = opening as { eco: string; name: string };
		out.opening = { eco: o.eco, name: o.name };
	} else out.opening = null;
	return out;
}

const defaultStorage: ExplorerStorage = {
	get: () => chromeLocalGet(LOCAL_KEYS.explorerCache),
	set: (store) => chromeLocalSet(LOCAL_KEYS.explorerCache, store),
};

export class ExplorerClient implements ExplorerQuery {
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private readonly storage: ExplorerStorage;
	private readonly timeoutSignal: (ms: number) => AbortSignal;
	private readonly cache = new LruCache<string, ExplorerCacheEntry>(EXPLORER.cacheEntries);
	private loaded: Promise<void> | null = null;
	private inFlight: { key: string; promise: Promise<ExplorerResponse | null> } | null = null;
	private backoffUntilMs = 0;
	private disposed = false;

	constructor(deps: ExplorerClientDeps = {}) {
		this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
		this.now = deps.now ?? (() => Date.now());
		this.storage = deps.storage ?? defaultStorage;
		this.timeoutSignal = deps.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
	}

	static cacheKey(fen: string, E: number, timeControl: TimeControl | undefined): string {
		return `${fen}|${ratingsFor(E).join(",")}|${speedsFor(timeControl).join(",")}`;
	}

	/** `now()` value until which requests are suppressed after a 429 (0 when none). */
	get backoffUntil(): number {
		return this.backoffUntilMs;
	}

	get inBackoff(): boolean {
		return this.now() < this.backoffUntilMs;
	}

	/**
	 * The explorer's answer for `(fen, ratings(E), speeds(tc))`: cached, or
	 * fetched when nothing else is in flight. `null` on back-off, a concurrent
	 * request for another key, timeout, HTTP error or a malformed body.
	 */
	async query(
		fen: string,
		E: number,
		timeControl: TimeControl | undefined
	): Promise<ExplorerResponse | null> {
		if (this.disposed) return null;
		await this.ensureLoaded();
		const key = ExplorerClient.cacheKey(fen, E, timeControl);
		const cached = this.cache.get(key);
		if (cached && this.now() - cached.at < EXPLORER.cacheTtlMs) return cached.data;
		if (cached) this.cache.delete(key);
		if (this.inBackoff) return null;
		if (this.inFlight) return this.inFlight.key === key ? this.inFlight.promise : null;
		const promise = this.request(key, explorerUrl(fen, E, timeControl)).finally(() => {
			if (this.inFlight?.promise === promise) this.inFlight = null;
		});
		this.inFlight = { key, promise };
		return promise;
	}

	dispose(): void {
		this.disposed = true;
		this.inFlight = null;
	}

	private ensureLoaded(): Promise<void> {
		if (!this.loaded) {
			this.loaded = this.storage
				.get()
				.then((store) => {
					if (!store) return;
					const now = this.now();
					const entries = Object.entries(store)
						.filter(([, e]) => now - e.at < EXPLORER.cacheTtlMs)
						.sort((a, b) => a[1].at - b[1].at);
					for (const [k, e] of entries) this.cache.set(k, e);
				})
				.catch((err: unknown) => {
					log.warn("explorer: cache load failed", err);
				});
		}
		return this.loaded;
	}

	private async persist(): Promise<void> {
		const store: ExplorerCacheStore = {};
		for (const [k, e] of this.cache.entries()) store[k] = e;
		try {
			await this.storage.set(store);
		} catch (err) {
			log.warn("explorer: cache write failed", err);
		}
	}

	private async request(key: string, url: string): Promise<ExplorerResponse | null> {
		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				headers: { accept: "application/json" },
				signal: this.timeoutSignal(TIMINGS.explorerTimeoutMs),
			});
		} catch (err) {
			log.debug("explorer: request failed", err);
			return null;
		}
		if (this.disposed) return null;
		if (res.status === 429) {
			this.backoffUntilMs = this.now() + EXPLORER.backoffMs;
			log.warn("explorer: rate limited; backing off", EXPLORER.backoffMs);
			return null;
		}
		if (!res.ok) {
			log.debug("explorer: HTTP", res.status);
			return null;
		}
		let body: unknown;
		try {
			body = await res.json();
		} catch (err) {
			log.debug("explorer: bad JSON", err);
			return null;
		}
		const data = parseExplorerResponse(body);
		if (!data) {
			log.debug("explorer: unexpected body shape");
			return null;
		}
		this.cache.set(key, { at: this.now(), data });
		await this.persist();
		return data;
	}
}
