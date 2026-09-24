// test/core/tablebase/client.test.ts — the client against a fake fetch: no network in the gate.
import { describe, expect, it } from "bun:test";
import { TABLEBASE, TABLEBASE_ENDPOINT } from "@core/constants/tablebase";
import { TablebaseClient, type TablebaseFetch } from "@core/tablebase/client";
import { KRK_LOSS, KRK_LOSS_FEN, KRK_WIN, KRK_WIN_FEN } from "./fixtures";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface Harness {
	client: TablebaseClient;
	urls: string[];
	inits: RequestInit[];
	clock: { now: number };
	sleeps: number[];
}

function harness(respond: (url: string, call: number) => Promise<Response> | Response): Harness {
	const urls: string[] = [];
	const inits: RequestInit[] = [];
	const clock = { now: 1_000_000 };
	const sleeps: number[] = [];
	const fetch: TablebaseFetch = async (url, init) => {
		urls.push(url);
		inits.push(init);
		return respond(url, urls.length);
	};
	const client = new TablebaseClient({
		fetch,
		now: () => clock.now,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.now += ms;
		},
	});
	return { client, urls, inits, clock, sleeps };
}

describe("TablebaseClient", () => {
	it("asks the endpoint with the counter-free FEN and no credentials", async () => {
		const h = harness(() => json(KRK_WIN));
		const probe = await h.client.probe("8/8/8/4k3/8/8/2K5/7R w - - 12 40");
		expect(probe?.category).toBe("win");
		expect(h.urls).toEqual([`${TABLEBASE_ENDPOINT}?fen=${encodeURIComponent(KRK_WIN_FEN)}`]);
		expect(h.inits[0]?.credentials).toBe("omit");
		expect(h.inits[0]?.signal).toBeDefined();
	});

	it("never asks about a position the tables do not cover", async () => {
		const h = harness(() => json(KRK_WIN));
		expect(await h.client.probe(START)).toBeNull();
		expect(await h.client.probe("garbage")).toBeNull();
		expect(h.urls).toHaveLength(0);
	});

	it("caches an answer and shares a request in flight", async () => {
		let release: (r: Response) => void = () => {};
		const h = harness(() => new Promise<Response>((resolve) => (release = resolve)));
		const a = h.client.probe(KRK_WIN_FEN);
		const b = h.client.probe("8/8/8/4k3/8/8/2K5/7R w - - 3 9");
		// Let the first request reach fetch before answering it.
		await Promise.resolve();
		release(json(KRK_WIN));
		expect((await a)?.category).toBe("win");
		expect(await b).toBe(await a);
		expect((await h.client.probe(KRK_WIN_FEN))?.category).toBe("win");
		expect(h.client.peek(KRK_WIN_FEN)?.category).toBe("win");
		expect(h.urls).toHaveLength(1);
	});

	it("spaces requests out as a courtesy to the public service", async () => {
		const h = harness((url) => json(url.includes("K6R") ? KRK_LOSS : KRK_WIN));
		await h.client.probe(KRK_WIN_FEN);
		await h.client.probe(KRK_LOSS_FEN);
		expect(h.sleeps).toEqual([TABLEBASE.minIntervalMs]);
	});

	it("goes quiet for a minute after HTTP 429", async () => {
		const h = harness((_, call) => (call === 1 ? json({}, 429) : json(KRK_WIN)));
		expect(await h.client.probe(KRK_WIN_FEN)).toBeNull();
		h.clock.now += TABLEBASE.rateLimitBackoffMs - 1;
		expect(await h.client.probe(KRK_WIN_FEN)).toBeNull();
		expect(h.urls).toHaveLength(1);
		h.clock.now += 1;
		expect((await h.client.probe(KRK_WIN_FEN))?.category).toBe("win");
		expect(h.urls).toHaveLength(2);
	});

	it("trips a breaker after consecutive failures, and a success resets the count", async () => {
		let mode: "fail" | "ok" = "fail";
		const h = harness(() => {
			if (mode === "ok") return json(KRK_WIN);
			throw new TypeError("Failed to fetch");
		});
		for (let i = 0; i < TABLEBASE.failureTripCount - 1; i += 1)
			expect(await h.client.probe(KRK_WIN_FEN)).toBeNull();
		mode = "ok";
		expect((await h.client.probe(KRK_WIN_FEN))?.category).toBe("win");
		mode = "fail";
		for (let i = 0; i < TABLEBASE.failureTripCount; i += 1)
			expect(await h.client.probe(KRK_LOSS_FEN)).toBeNull();
		const asked = h.urls.length;
		mode = "ok";
		expect(await h.client.probe(KRK_LOSS_FEN)).toBeNull();
		expect(h.urls).toHaveLength(asked);
		h.clock.now += TABLEBASE.failureBackoffMs;
		expect(await h.client.probe(KRK_LOSS_FEN)).not.toBeNull();
	});

	it("counts a server error or a malformed answer as a failure, not an answer", async () => {
		const h = harness((_, call) =>
			call === 1 ? json({}, 503) : call === 2 ? json({ oops: 1 }) : json(KRK_WIN)
		);
		expect(await h.client.probe(KRK_WIN_FEN)).toBeNull();
		expect(await h.client.probe(KRK_WIN_FEN)).toBeNull();
		expect((await h.client.probe(KRK_WIN_FEN))?.category).toBe("win");
		expect(h.urls).toHaveLength(3);
	});

	it("remembers a position the service refuses", async () => {
		const h = harness(() => json({ error: "invalid fen" }, 400));
		expect(await h.client.probe(KRK_WIN_FEN)).toBeNull();
		expect(await h.client.probe(KRK_WIN_FEN)).toBeNull();
		expect(h.urls).toHaveLength(1);
	});

	it("keeps a bounded cache, evicting the least recently used position", async () => {
		const h = harness(() => json(KRK_WIN));
		const fens = distinctPositions(TABLEBASE.cacheEntries + 1);
		const [first, second] = fens;
		if (first === undefined || second === undefined) throw new Error("too few positions");
		for (const fen of fens.slice(0, TABLEBASE.cacheEntries)) await h.client.probe(fen);
		// Touch the oldest so the second-oldest is evicted by the next new position.
		await h.client.probe(first);
		await h.client.probe(fens[TABLEBASE.cacheEntries] ?? "");
		expect(h.client.peek(first)).toBeDefined();
		expect(h.client.peek(second)).toBeUndefined();
		expect(h.urls).toHaveLength(TABLEBASE.cacheEntries + 1);
	});
});

/** `n` distinct legal four-man positions (Ka1, kh8, a rook and a knight; black to move). */
function distinctPositions(n: number): string[] {
	const squares: number[] = [];
	for (let i = 0; i < 64; i += 1) if (i !== 56 && i !== 7) squares.push(i);
	const out: string[] = [];
	for (const r of squares)
		for (const k of squares) {
			if (r === k || out.length >= n) continue;
			const board: string[] = new Array(64).fill("");
			board[56] = "K"; // a1 (index 0 is a8)
			board[7] = "k"; // h8
			board[r] = "R";
			board[k] = "N";
			const rows: string[] = [];
			for (let row = 0; row < 8; row += 1) {
				let text = "";
				let empty = 0;
				for (let col = 0; col < 8; col += 1) {
					const piece = board[row * 8 + col] ?? "";
					if (piece === "") empty += 1;
					else {
						if (empty > 0) text += String(empty);
						empty = 0;
						text += piece;
					}
				}
				if (empty > 0) text += String(empty);
				rows.push(text);
			}
			out.push(`${rows.join("/")} b - - 0 1`);
		}
	return out;
}
