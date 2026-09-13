// test/core/engine/analysis-cache.test.ts
import { describe, expect, it } from "bun:test";
import { historyKey } from "@core/chess/history";
import { LIMITS } from "@core/constants/limits";
import { TIMINGS } from "@core/constants/timings";
import {
	AnalysisCache,
	cacheKey,
	fenKey,
	isCacheable,
	limitKey,
} from "@core/engine/analysis-cache";
import type {
	AnalysisLimit,
	AnalysisRequest,
	AnalysisResult,
	AnalysisStatus,
} from "@core/engine/types";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const START_LATER = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 12";
const OTHER = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
/** The same position as `OTHER`, spelled by a chess.js replay: no pawn can take on e3. */
const EP_UNUSABLE = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
/** A *different* position: the pawn on d4 can take on e3, so the square belongs to it. */
const EP_USABLE = "rnbqkbnr/pppp1ppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

function result(
	fen: string,
	depth: number,
	opts: {
		multiPv?: number;
		elo?: number;
		limit?: AnalysisLimit;
		status?: AnalysisStatus;
		id?: string;
		/** `final.complete` (default true). */
		finalComplete?: boolean;
	} = {}
): AnalysisResult {
	const request: AnalysisRequest = {
		id: opts.id ?? `${fen}-${depth}`,
		fen,
		multiPv: opts.multiPv ?? 4,
		limit: opts.limit ?? { movetimeMs: 800 },
	};
	if (opts.elo !== undefined) request.elo = opts.elo;
	const out: AnalysisResult = {
		id: request.id,
		bestmove: "e2e4",
		final: {
			id: request.id,
			depth,
			lines: [],
			nodes: 0,
			nps: 0,
			timeMs: 0,
			complete: opts.finalComplete ?? true,
		},
		status: opts.status ?? "complete",
		request,
	};
	if (opts.elo !== undefined) out.engineElo = opts.elo;
	return out;
}

describe("keys", () => {
	it("fenKey drops the halfmove/fullmove fields", () => {
		expect(fenKey(START)).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
		expect(fenKey(START_LATER)).toBe(fenKey(START));
		expect(fenKey("  a b c d 1 2 ")).toBe("a b c d");
	});
	// Three sources spell the same position differently: chess.com's `getFEN()` names the
	// en-passant square after any double push, a chess.js replay only when a pawn can capture
	// there, and a DOM reconstruction only when it can infer the last move. Keyed raw, the
	// ponder → own-move handoff missed on every double push.
	it("fenKey normalises an en-passant square no pawn can use", () => {
		// OTHER is chess.com's spelling of `applyMoves(START, ["e2e4"])`; EP_UNUSABLE is chess.js's.
		expect(fenKey(OTHER)).toBe(fenKey(EP_UNUSABLE));
		expect(fenKey(OTHER)).not.toContain("e3");
	});
	it("…and keeps one a pawn can: those are different positions", () => {
		// a black pawn on d4 really can take on e3, so the ep square is part of the position
		expect(fenKey(EP_USABLE)).toContain("e3");
		expect(fenKey(EP_USABLE)).not.toBe(fenKey(EP_USABLE.replace(" e3 ", " - ")));
	});
	it("a result stored under one spelling is found under the other", () => {
		const cache = new AnalysisCache();
		cache.set(result(EP_UNUSABLE, 14));
		expect(cache.get(OTHER, 4, 12)).toBeDefined();
		expect(cache.get(OTHER, 4, 12)?.request.fen).toBe(EP_UNUSABLE);
	});
	it("limitKey encodes each limit shape", () => {
		expect(limitKey({ infinite: true })).toBe("inf");
		expect(limitKey({ depth: 12 })).toBe("d12");
		expect(limitKey({ movetimeMs: 800 })).toBe("t800");
		expect(limitKey({ depth: 12, movetimeMs: 800 })).toBe("d12t800");
		expect(limitKey({ nodes: 5000 })).toBe("n5000");
		expect(limitKey({ depth: 12, nodes: 5000 })).toBe("d12n5000");
		// an empty limit is what the client sends as the default movetime
		expect(limitKey({})).toBe(`t${TIMINGS.analysisDefaultMovetimeMs}`);
		expect(limitKey({})).toBe(limitKey({ movetimeMs: TIMINGS.analysisDefaultMovetimeMs }));
	});
	it("cacheKey is fen|multiPv|elo|limit with `full` for full strength", () => {
		expect(cacheKey(START_LATER, 4, 1500, { movetimeMs: 800 })).toBe(
			`${historyKey(START_LATER)}|4|1500|t800`
		);
		expect(cacheKey(START, 4, undefined, { infinite: true })).toBe(`${historyKey(START)}|4|full|inf`);
	});
	// H4 (2026-09-13): the human frame is part of the identity, but the default keys as before.
	it("cacheKey adds an `f<depth>` segment only for a non-default featureDepth", () => {
		const plain = cacheKey(START, 4, undefined, { movetimeMs: 800 });
		expect(cacheKey(START, 4, undefined, { movetimeMs: 800 }, [], LIMITS.featureDepth)).toBe(plain);
		expect(cacheKey(START, 4, undefined, { movetimeMs: 800 }, [], 4)).toBe(`${plain}|f4`);
		expect(cacheKey(START, 4, undefined, { movetimeMs: 800 }, ["e2e4"], 6)).toBe(
			`${historyKey(START, ["e2e4"])}|4|full|t800|f6`
		);
	});
});

describe("AnalysisCache", () => {
	it("never stores a `searchmoves` result: a restricted search is not an analysis of the position", () => {
		const c = new AnalysisCache();
		const restricted = result(START, 14, { multiPv: 3, id: "restricted" });
		restricted.request.searchmoves = ["b1c3", "a2a3", "h2h3"];
		expect(isCacheable(restricted)).toBe(true);
		c.set(restricted);
		expect(c.size).toBe(0);
		expect(c.get(START, 3, 12)).toBeUndefined();
		expect(c.get(START, 1, 1)).toBeUndefined();
		// an empty list is no restriction
		const open = result(START, 14, { multiPv: 3, id: "open" });
		open.request.searchmoves = [];
		c.set(open);
		expect(c.get(START, 3, 12)).toBe(open);
	});

	// H10 (2026-09-13): the Maia-shaped own-move search is a restricted search whose roots are part
	// of its identity — stored, and answered only by the identical root set.
	it("cacheKey adds an `sm:` segment with the sorted roots only for a restricted search (H10)", () => {
		const plain = cacheKey(START, 4, undefined, { movetimeMs: 800 });
		expect(cacheKey(START, 4, undefined, { movetimeMs: 800 }, [], LIMITS.featureDepth, [])).toBe(
			plain
		);
		expect(
			cacheKey(START, 4, undefined, { movetimeMs: 800 }, [], LIMITS.featureDepth, [
				"e2e4",
				"b1c3",
				"d2d4",
			])
		).toBe(`${plain}|sm:b1c3,d2d4,e2e4`);
		// order-insensitive: the key is the set
		expect(
			cacheKey(START, 4, undefined, { movetimeMs: 800 }, [], LIMITS.featureDepth, [
				"d2d4",
				"e2e4",
				"b1c3",
			])
		).toBe(`${plain}|sm:b1c3,d2d4,e2e4`);
		expect(cacheKey(START, 4, undefined, { movetimeMs: 800 }, ["e2e4"], 6, ["e7e5"])).toBe(
			`${historyKey(START, ["e2e4"])}|4|full|t800|f6|sm:e7e5`
		);
	});

	it("stores a `shaped` restricted result under its roots and answers only the same set (H10)", () => {
		const c = new AnalysisCache();
		const shaped = result(START, 14, { multiPv: 3, id: "shaped" });
		shaped.request.searchmoves = ["e2e4", "b1c3", "d2d4"];
		shaped.request.shaped = true;
		c.set(shaped);
		expect(c.size).toBe(1);
		// the same roots in any order hit; a subset, a superset and an unrestricted request miss
		expect(
			c.get(START, 3, 12, undefined, [], Number.POSITIVE_INFINITY, LIMITS.featureDepth, [
				"d2d4",
				"e2e4",
				"b1c3",
			])
		).toBe(shaped);
		expect(
			c.get(START, 3, 12, undefined, [], Number.POSITIVE_INFINITY, LIMITS.featureDepth, [
				"e2e4",
				"b1c3",
			])
		).toBeUndefined();
		expect(
			c.get(START, 3, 12, undefined, [], Number.POSITIVE_INFINITY, LIMITS.featureDepth, [
				"e2e4",
				"b1c3",
				"d2d4",
				"g1f3",
			])
		).toBeUndefined();
		expect(c.get(START, 3, 12)).toBeUndefined();
		// an unrestricted result never answers a restricted request either
		const open = result(START, 14, { multiPv: 20, id: "open" });
		c.set(open);
		expect(
			c.get(START, 3, 12, undefined, [], Number.POSITIVE_INFINITY, LIMITS.featureDepth, [
				"e2e4",
				"b1c3",
				"d2d4",
			])
		).toBe(shaped);
		expect(c.get(START, 3, 12)).toBe(open);
		// the same restriction without the flag is still never stored
		const extra = result(START, 14, { multiPv: 3, id: "extra" });
		extra.request.searchmoves = ["a2a3", "h2h3", "b2b3"];
		c.set(extra);
		expect(c.size).toBe(2);
		expect(
			c.get(START, 3, 12, undefined, [], Number.POSITIVE_INFINITY, LIMITS.featureDepth, [
				"a2a3",
				"h2h3",
				"b2b3",
			])
		).toBeUndefined();
	});

	it("a result answers only a request for the same human frame (H4)", () => {
		const cache = new AnalysisCache();
		const human = result(START, 14, { id: "human" });
		human.request.featureDepth = 4;
		const plain = result(START, 14, { id: "plain" });
		cache.set(human);
		cache.set(plain);
		expect(cache.size).toBe(2);
		// the default frame, asked for explicitly or by omission, is the plain result
		expect(cache.get(START, 4, 12)?.id).toBe("plain");
		expect(
			cache.get(START, 4, 12, undefined, [], Number.POSITIVE_INFINITY, LIMITS.featureDepth)?.id
		).toBe("plain");
		expect(cache.get(START, 4, 12, undefined, [], Number.POSITIVE_INFINITY, 4)?.id).toBe("human");
		expect(cache.get(START, 4, 12, undefined, [], Number.POSITIVE_INFINITY, 6)).toBeUndefined();
		// a deeper plain result does not answer a human-frame request however deep it is
		cache.set(result(START, 24, { id: "deeper" }));
		expect(cache.get(START, 4, 12, undefined, [], Number.POSITIVE_INFINITY, 4)?.id).toBe("human");
	});

	it("does not use a deeper unrestricted result above an explicit depth ceiling", () => {
		const cache = new AnalysisCache();
		const deep = result(START, 20, { elo: 1500, limit: { infinite: true } });
		const shallow = result(START, 6, { elo: 1500, limit: { depth: 6, movetimeMs: 100 } });
		cache.set(deep);
		expect(cache.get(START, 4, 6, 1500, [], 6)).toBeUndefined();
		cache.set(shallow);
		expect(cache.get(START, 4, 6, 1500, [], 6)).toBe(shallow);
		expect(cache.get(START, 4, 6, 1500)).toBe(deep);
	});

	it("returns complete results at or above the requested depth for the same fen/elo", () => {
		const c = new AnalysisCache();
		const r = result(START, 14, { elo: 1500 });
		c.set(r);
		expect(c.get(START, 4, 12, 1500)).toBe(r);
		expect(c.get(START_LATER, 4, 14, 1500)).toBeUndefined();
		expect(c.get(START.replace("0 1", "0 12"), 4, 14, 1500)).toBe(r);
		expect(c.get(START, 4, 15, 1500)).toBeUndefined();
		expect(c.get(START, 4, 12)).toBeUndefined();
		expect(c.get(START, 4, 12, 1400)).toBeUndefined();
		expect(c.get(OTHER, 4, 12, 1500)).toBeUndefined();
	});
	it("requires multiPv >= requested and picks the deepest match", () => {
		const c = new AnalysisCache();
		const shallow = result(START, 10, { multiPv: 6, limit: { movetimeMs: 200 } });
		const deep = result(START, 16, { multiPv: 4, limit: { movetimeMs: 800 } });
		c.set(shallow);
		c.set(deep);
		expect(c.get(START, 4, 8)).toBe(deep);
		expect(c.get(START, 6, 8)).toBe(shallow);
		expect(c.get(START, 8, 8)).toBeUndefined();
	});
	it("requires a complete final iteration even when the request finished normally", () => {
		const c = new AnalysisCache();
		// a ponder cancelled by the next analyse, with a complete depth-20 iteration → cached
		const ponder = result(START, 20, { status: "superseded", limit: { infinite: true } });
		expect(isCacheable(ponder)).toBe(true);
		c.set(ponder);
		expect(c.get(START, 4, 20)).toBe(ponder);
		// superseded before any iteration completed → not cached
		const early = result(OTHER, 3, { status: "superseded", finalComplete: false });
		expect(isCacheable(early)).toBe(false);
		c.set(early);
		expect(c.get(OTHER, 4, 1)).toBeUndefined();
		// failed → never
		c.set(result(OTHER, 20, { status: "failed", limit: { depth: 20 } }));
		expect(c.get(OTHER, 4, 1)).toBeUndefined();
		expect(c.size).toBe(1);
		// Normal request completion does not imply a complete MultiPV iteration.
		const partial = result(OTHER, 12, { finalComplete: false });
		expect(isCacheable(partial)).toBe(false);
		c.set(partial);
		expect(c.get(OTHER, 4, 12)).toBeUndefined();
		expect(c.get(OTHER, 4, 13)).toBeUndefined();
		expect(c.size).toBe(1);
	});
	it("does not let a deep partial pair masquerade as a twenty-candidate search", () => {
		const cache = new AnalysisCache();
		const partial = result(START, 18, { multiPv: 20, finalComplete: false, elo: 1650 });
		partial.final.lines = ["e2e4", "d2d4"].map((move, index) => ({
			multipv: index + 1,
			depth: 18,
			score: { cp: 30 - index * 10 },
			pvUci: [move],
			pvSan: [],
		}));
		cache.set(partial);
		expect(cache.get(START, 20, 6, 1650)).toBeUndefined();
		expect(cache.get(START, 2, 6, 1650)).toBeUndefined();
		expect(cache.size).toBe(0);
	});
	it("replaces an entry with the same key", () => {
		const c = new AnalysisCache();
		c.set(result(START, 10, { id: "a" }));
		c.set(result(START.replace("0 1", "0 12"), 12, { id: "b" }));
		expect(c.size).toBe(1);
		expect(c.get(START, 4, 1)?.id).toBe("b");
	});
	it("evicts least-recently-used entries at LIMITS.analysisCacheEntries", () => {
		const c = new AnalysisCache();
		const fens: string[] = [];
		for (let i = 0; i < LIMITS.analysisCacheEntries; i++) {
			const fen = `8/8/8/8/8/8/8/K6k w - - 0 ${i}`;
			// distinct placements so the fenKey differs
			const placement = `${i.toString(2).padStart(8, "0").split("").join("/")}`;
			const f = `${placement} w - - 0 1`;
			fens.push(f);
			c.set(result(f, 10, { id: fen }));
		}
		expect(c.size).toBe(LIMITS.analysisCacheEntries);
		// touch the first so the second becomes the oldest
		expect(c.get(fens[0] as string, 4, 1)).toBeDefined();
		c.set(result(OTHER, 10));
		expect(c.size).toBe(LIMITS.analysisCacheEntries);
		expect(c.get(fens[0] as string, 4, 1)).toBeDefined();
		expect(c.get(fens[1] as string, 4, 1)).toBeUndefined();
		expect(c.get(OTHER, 4, 1)).toBeDefined();
	});
	it("honours a custom capacity and clear()", () => {
		const c = new AnalysisCache(2);
		c.set(result(START, 10));
		c.set(result(OTHER, 10));
		c.set(result(START, 10, { limit: { depth: 5 } }));
		expect(c.size).toBe(2);
		c.clear();
		expect(c.size).toBe(0);
		expect(c.get(START, 4, 1)).toBeUndefined();
	});
});
