// test/core/strength/book/explorer.test.ts
import { describe, expect, it } from "bun:test";
import { EXPLORER } from "@core/constants/books";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TIMINGS } from "@core/constants/timings";
import { createRng } from "@core/rng";
import {
	type ExplorerCacheStore,
	ExplorerClient,
	type ExplorerMove,
	type ExplorerResponse,
	explorerUrl,
	type FetchLike,
	gammaFor,
	ratingsFor,
	sampleBookMove,
	speedFor,
	speedsFor,
} from "@core/strength/book/explorer";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function move(uci: string, n: number): ExplorerMove {
	return { uci, san: uci, white: n, draws: 0, black: 0, averageRating: 1500 };
}

function response(moves: ExplorerMove[]): ExplorerResponse {
	let white = 0;
	let draws = 0;
	let black = 0;
	for (const m of moves) {
		white += m.white;
		draws += m.draws;
		black += m.black;
	}
	return { white, draws, black, moves, opening: null };
}

interface FakeFetchOptions {
	status?: number;
	body?: ExplorerResponse;
	/** Resolve only when the request signal aborts (simulates a hung server). */
	hang?: boolean;
	/** Delay before resolving (real ms). */
	delayMs?: number;
}

function fakeFetch(opts: FakeFetchOptions = {}) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const fetchImpl: FetchLike = (url, init) => {
		calls.push({ url, init });
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		return new Promise<Response>((resolve, reject) => {
			const signal = init?.signal;
			const finish = () => {
				inFlight--;
				resolve(
					new Response(JSON.stringify(opts.body ?? response([move("e2e4", 500)])), {
						status: opts.status ?? 200,
						headers: { "content-type": "application/json" },
					})
				);
			};
			if (signal?.aborted) {
				inFlight--;
				reject(signal.reason ?? new DOMException("aborted", "AbortError"));
				return;
			}
			if (opts.hang) {
				signal?.addEventListener("abort", () => {
					inFlight--;
					reject(signal.reason ?? new DOMException("aborted", "AbortError"));
				});
				return;
			}
			setTimeout(finish, opts.delayMs ?? 0);
		});
	};
	return {
		fetch: fetchImpl,
		calls,
		get maxInFlight() {
			return maxInFlight;
		},
	};
}

function memoryStorage(initial: ExplorerCacheStore | null = null) {
	let value: ExplorerCacheStore | null = initial;
	let writes = 0;
	return {
		get: async () => value,
		set: async (v: ExplorerCacheStore) => {
			value = v;
			writes++;
		},
		get value() {
			return value;
		},
		get writes() {
			return writes;
		},
	};
}

describe("ratingsFor", () => {
	it("picks the three buckets around E (1500 → 1400,1600,1800)", () => {
		expect(ratingsFor(1500)).toEqual([1400, 1600, 1800]);
	});
	it("dedupes at the edges of the bucket list", () => {
		expect(ratingsFor(3000)).toEqual([2500]);
		expect(ratingsFor(2400)).toEqual([2200, 2500]);
		expect(ratingsFor(400)).toEqual([0, 1000]);
	});
});

describe("speedFor / speedsFor", () => {
	it("classifies by estimated total = base + 40·inc", () => {
		expect(speedFor({ baseMs: 15_000, incMs: 0 })).toBe("ultraBullet");
		expect(speedFor({ baseMs: 60_000, incMs: 0 })).toBe("bullet");
		expect(speedFor({ baseMs: 120_000, incMs: 1_000 })).toBe("bullet"); // 160 s
		expect(speedFor({ baseMs: 180_000, incMs: 0 })).toBe("blitz");
		expect(speedFor({ baseMs: 180_000, incMs: 2_000 })).toBe("blitz"); // 260 s
		expect(speedFor({ baseMs: 300_000, incMs: 3_000 })).toBe("blitz"); // 420 s
		expect(speedFor({ baseMs: 600_000, incMs: 0 })).toBe("rapid");
		expect(speedFor({ baseMs: 900_000, incMs: 10_000 })).toBe("rapid"); // 1300 s
		expect(speedFor({ baseMs: 1_800_000, incMs: 0 })).toBe("classical");
		expect(speedFor(undefined)).toBe("blitz");
	});
	it("adds the slower neighbour (or the faster one for classical)", () => {
		expect(speedsFor({ baseMs: 180_000, incMs: 0 })).toEqual(["blitz", "rapid"]);
		expect(speedsFor({ baseMs: 60_000, incMs: 0 })).toEqual(["bullet", "blitz"]);
		expect(speedsFor({ baseMs: 1_800_000, incMs: 0 })).toEqual(["rapid", "classical"]);
	});
});

describe("explorerUrl", () => {
	it("matches the documented query format", () => {
		const url = explorerUrl(START, 1500, { baseMs: 180_000, incMs: 0 });
		expect(url.startsWith("https://explorer.lichess.ovh/lichess?")).toBe(true);
		expect(url).toContain("variant=standard");
		expect(url).toContain(`fen=${encodeURIComponent(START)}`);
		expect(url).toContain("speeds=blitz,rapid");
		expect(url).toContain("ratings=1400,1600,1800");
		expect(url).toContain(`moves=${EXPLORER.moves}`);
		expect(url).toContain("topGames=0");
		expect(url).toContain("recentGames=0");
	});
});

describe("gammaFor / sampleBookMove", () => {
	it("γ(E) = 0.75 + 0.25·clamp((E − 1200)/1200, 0, 1)", () => {
		expect(gammaFor(800)).toBeCloseTo(0.75);
		expect(gammaFor(1200)).toBeCloseTo(0.75);
		expect(gammaFor(1800)).toBeCloseTo(0.875);
		expect(gammaFor(2400)).toBeCloseTo(1);
		expect(gammaFor(3000)).toBeCloseTo(1);
	});

	it("drops moves with n < max(5, 0.02·N)", () => {
		const moves = [move("e2e4", 900), move("d2d4", 80), move("c2c4", 15), move("h2h4", 4)];
		const rng = createRng(1);
		const seen = new Set<string>();
		for (let i = 0; i < 400; i++) {
			const m = sampleBookMove(moves, 1500, rng);
			if (m) seen.add(m.uci);
		}
		expect(seen.has("e2e4")).toBe(true);
		expect(seen.has("d2d4")).toBe(true);
		expect(seen.has("c2c4")).toBe(false); // 15 < 0.02·999
		expect(seen.has("h2h4")).toBe(false);
	});

	it("samples p ∝ n^γ: flatter for weak E, near-proportional for strong E", () => {
		const moves = [move("e2e4", 800), move("d2d4", 200)];
		const share = (E: number) => {
			const rng = createRng(42);
			let e4 = 0;
			const trials = 4000;
			for (let i = 0; i < trials; i++) if (sampleBookMove(moves, E, rng)?.uci === "e2e4") e4++;
			return e4 / trials;
		};
		// γ = 1 → 0.8; γ = 0.75 → 800^.75/(800^.75+200^.75) ≈ 0.738.
		expect(share(2400)).toBeGreaterThan(0.77);
		expect(share(2400)).toBeLessThan(0.83);
		expect(share(800)).toBeGreaterThan(0.71);
		expect(share(800)).toBeLessThan(0.77);
	});

	it("returns null when nothing survives the filter", () => {
		expect(sampleBookMove([], 1500, createRng(1))).toBeNull();
		expect(sampleBookMove([move("e2e4", 3)], 1500, createRng(1))).toBeNull();
	});
});

describe("ExplorerClient", () => {
	const tc = { baseMs: 180_000, incMs: 0 };

	it("fetches with the documented URL, an Accept header and a timeout signal, then caches", async () => {
		const ff = fakeFetch({ body: response([move("e2e4", 300), move("d2d4", 100)]) });
		const storage = memoryStorage();
		let t = 1_000_000;
		const client = new ExplorerClient({ fetch: ff.fetch, now: () => t, storage });
		const first = await client.query(START, 1500, tc);
		expect(first?.moves.map((m) => m.uci)).toEqual(["e2e4", "d2d4"]);
		expect(ff.calls.length).toBe(1);
		const call = ff.calls[0];
		expect(call?.url).toBe(explorerUrl(START, 1500, tc));
		expect(new Headers(call?.init?.headers).get("accept")).toBe("application/json");
		expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
		expect(storage.writes).toBe(1);
		expect(Object.keys(storage.value ?? {}).length).toBe(1);

		t += 1_000;
		const second = await client.query(START, 1500, tc);
		expect(second).toEqual(first);
		expect(ff.calls.length).toBe(1); // served from the cache
		client.dispose();
	});

	it("expires cache entries after the 30-day TTL", async () => {
		const ff = fakeFetch();
		let t = 1_000_000;
		const client = new ExplorerClient({ fetch: ff.fetch, now: () => t, storage: memoryStorage() });
		await client.query(START, 1500, tc);
		t += EXPLORER.cacheTtlMs + 1;
		await client.query(START, 1500, tc);
		expect(ff.calls.length).toBe(2);
		client.dispose();
	});

	it("loads the persisted cache and evicts the oldest entries beyond the LRU capacity", async () => {
		const ff = fakeFetch();
		const now = 5_000_000;
		const store: ExplorerCacheStore = {};
		const cached = response([move("g1f3", 999)]);
		store[ExplorerClient.cacheKey(START, 1500, tc)] = { at: now - 10, data: cached };
		for (let i = 0; i < EXPLORER.cacheEntries + 50; i++)
			store[`k${i}`] = { at: now - 1_000_000 + i, data: cached };
		const storage = memoryStorage(store);
		const client = new ExplorerClient({ fetch: ff.fetch, now: () => now, storage });
		const res = await client.query(START, 1500, tc);
		expect(res?.moves[0]?.uci).toBe("g1f3");
		expect(ff.calls.length).toBe(0);
		await client.query("8/8/8/8/8/8/8/k6K w - - 0 1", 1500, tc); // forces a write
		expect(Object.keys(storage.value ?? {}).length).toBe(EXPLORER.cacheEntries);
		expect(storage.value?.[ExplorerClient.cacheKey(START, 1500, tc)]).toBeDefined();
		expect(storage.value?.k0).toBeUndefined();
		client.dispose();
	});

	it("keeps one request in flight and shares the result between concurrent callers", async () => {
		const ff = fakeFetch({ delayMs: 5 });
		const client = new ExplorerClient({ fetch: ff.fetch, now: Date.now, storage: memoryStorage() });
		const [a, b] = await Promise.all([client.query(START, 1500, tc), client.query(START, 1500, tc)]);
		expect(a).toEqual(b);
		expect(ff.calls.length).toBe(1);
		expect(ff.maxInFlight).toBe(1);
		client.dispose();
	});

	it("returns null (no request) for a different position while another request is in flight", async () => {
		const ff = fakeFetch({ delayMs: 5 });
		const client = new ExplorerClient({ fetch: ff.fetch, now: Date.now, storage: memoryStorage() });
		const p = client.query(START, 1500, tc);
		const other = await client.query("8/8/8/8/8/8/8/k6K w - - 0 1", 1500, tc);
		expect(other).toBeNull();
		await p;
		expect(ff.calls.length).toBe(1);
		client.dispose();
	});

	it("backs off for 60 s after a 429", async () => {
		const ff = fakeFetch({ status: 429 });
		let t = 1_000_000;
		const client = new ExplorerClient({ fetch: ff.fetch, now: () => t, storage: memoryStorage() });
		expect(await client.query(START, 1500, tc)).toBeNull();
		expect(client.backoffUntil).toBe(t + EXPLORER.backoffMs);
		expect(client.inBackoff).toBe(true);
		t += EXPLORER.backoffMs - 1;
		expect(await client.query(START, 1600, tc)).toBeNull();
		expect(ff.calls.length).toBe(1);
		t += 1;
		expect(client.inBackoff).toBe(false);
		await client.query(START, 1600, tc);
		expect(ff.calls.length).toBe(2);
		client.dispose();
	});

	it("aborts a hung request after TIMINGS.explorerTimeoutMs and returns null", async () => {
		const ff = fakeFetch({ hang: true });
		const timeouts: number[] = [];
		const client = new ExplorerClient({
			fetch: ff.fetch,
			now: Date.now,
			storage: memoryStorage(),
			timeoutSignal: (ms) => {
				timeouts.push(ms);
				return AbortSignal.timeout(20);
			},
		});
		expect(await client.query(START, 1500, tc)).toBeNull();
		expect(timeouts).toEqual([TIMINGS.explorerTimeoutMs]);
		expect(client.inBackoff).toBe(false);
		client.dispose();
	});

	it("returns null on a non-OK status or a malformed body without caching", async () => {
		const ff = fakeFetch({ status: 500 });
		const storage = memoryStorage();
		const client = new ExplorerClient({ fetch: ff.fetch, now: Date.now, storage });
		expect(await client.query(START, 1500, tc)).toBeNull();
		expect(storage.writes).toBe(0);
		client.dispose();
	});

	it("uses chrome.storage.local under LOCAL_KEYS.explorerCache by default", async () => {
		const ff = fakeFetch();
		const client = new ExplorerClient({ fetch: ff.fetch });
		await client.query(START, 1500, tc);
		const stored = await new Promise<Record<string, unknown>>((resolve) =>
			chrome.storage.local.get(LOCAL_KEYS.explorerCache, (items) => resolve(items))
		);
		const store = stored[LOCAL_KEYS.explorerCache] as ExplorerCacheStore | undefined;
		expect(store?.[ExplorerClient.cacheKey(START, 1500, tc)]).toBeDefined();
		client.dispose();
		await new Promise<void>((resolve) =>
			chrome.storage.local.remove(LOCAL_KEYS.explorerCache, () => resolve())
		);
	});
});
