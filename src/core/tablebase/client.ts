/**
 * The tablebase client: one Lichess tablebase API request per unseen position, from the service
 * worker only. Robustness over reach — the engine always has an answer, so the tablebase is an
 * improvement when it is quick and available and silent when it is not:
 *
 * - **cache**: a bounded LRU keyed by `probeFen` (the tables do not read the counters), so a
 *   repeated or re-searched position never asks twice; an unusable answer is cached as `null`;
 * - **one request per position**: concurrent probes share the request in flight, and a caller that
 *   stops waiting leaves it running so the next probe of the position finds the answer cached;
 * - **timeout**: every request is aborted after `TABLEBASE.timeoutMs`;
 * - **courtesy**: requests are spaced `TABLEBASE.minIntervalMs` apart, an HTTP 429 silences the
 *   client for `TABLEBASE.rateLimitBackoffMs`, and `TABLEBASE.failureTripCount` consecutive
 *   failures (offline, 5xx, malformed) for `TABLEBASE.failureBackoffMs`.
 *
 * The request carries a FEN and nothing else (no cookies, no identifiers). It never runs in the page
 * realm: `scripts/verify-dist.ts` keeps the host out of every bundle but the service worker's.
 */

import { TABLEBASE, TABLEBASE_ENDPOINT } from "@core/constants/tablebase";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { inTablebaseRange, parseProbe, probeFen, type TablebaseProbe } from "./probe";

export type TablebaseFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TablebaseClientDeps {
	fetch?: TablebaseFetch;
	now?: () => number;
	/** Wait out the courtesy spacing; defaults to a timer. */
	sleep?: (ms: number) => Promise<void>;
}

/** What the pipeline needs from a tablebase: an answer for a position, or `null`. */
export interface TablebasePort {
	/** The tables' answer for `fen`, or `null` when out of range, unavailable or unusable. */
	probe(fen: string): Promise<TablebaseProbe | null>;
}

export class TablebaseClient implements TablebasePort {
	private readonly fetchImpl: TablebaseFetch;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly cache = new Map<string, TablebaseProbe | null>();
	private readonly inflight = new Map<string, Promise<TablebaseProbe | null>>();
	private nextRequestAt = 0;
	private pausedUntil = 0;
	private failures = 0;

	constructor(deps: TablebaseClientDeps = {}) {
		this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
		this.now = deps.now ?? Date.now;
		this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** The cached answer for `fen` without asking the network (`undefined` when never asked). */
	peek(fen: string): TablebaseProbe | null | undefined {
		const key = probeFen(fen);
		return key === null ? null : this.cache.get(key);
	}

	probe(fen: string): Promise<TablebaseProbe | null> {
		if (!inTablebaseRange(fen)) return Promise.resolve(null);
		const key = probeFen(fen);
		if (key === null) return Promise.resolve(null);
		if (this.cache.has(key)) {
			const hit = this.cache.get(key) ?? null;
			// Refresh the entry's recency.
			this.cache.delete(key);
			this.cache.set(key, hit);
			return Promise.resolve(hit);
		}
		const pending = this.inflight.get(key);
		if (pending) return pending;
		if (this.now() < this.pausedUntil) return Promise.resolve(null);
		const request = this.request(key).finally(() => this.inflight.delete(key));
		this.inflight.set(key, request);
		return request;
	}

	private remember(key: string, value: TablebaseProbe | null): void {
		this.cache.set(key, value);
		while (this.cache.size > TABLEBASE.cacheEntries) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}

	private fail(reason: string, pauseMs?: number): null {
		this.failures += 1;
		const pause =
			pauseMs ?? (this.failures >= TABLEBASE.failureTripCount ? TABLEBASE.failureBackoffMs : 0);
		if (pause > 0) {
			this.pausedUntil = this.now() + pause;
			this.failures = 0;
		}
		log.debug("tablebase: probe failed", { reason, pausedMs: pause });
		return null;
	}

	private async request(key: string): Promise<TablebaseProbe | null> {
		const wait = this.nextRequestAt - this.now();
		if (wait > 0) await this.sleep(wait);
		this.nextRequestAt = this.now() + TABLEBASE.minIntervalMs;
		const url = `${TABLEBASE_ENDPOINT}?fen=${encodeURIComponent(key)}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				credentials: "omit",
				signal: AbortSignal.timeout(TABLEBASE.timeoutMs),
			});
		} catch (error) {
			return this.fail(errorMessage(error));
		}
		if (response.status === 429) return this.fail("rate-limited", TABLEBASE.rateLimitBackoffMs);
		if (!response.ok) {
			// A 4xx names this position as unanswerable; anything else is the service's trouble.
			if (response.status >= 400 && response.status < 500) {
				this.remember(key, null);
				return null;
			}
			return this.fail(`HTTP ${response.status}`);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			return this.fail(`not JSON: ${errorMessage(error)}`);
		}
		const probe = parseProbe(body);
		if (!probe) return this.fail("malformed answer");
		this.failures = 0;
		this.remember(key, probe);
		return probe;
	}
}
