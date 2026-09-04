// test/core/engine/analysis-cache.test.ts
import { describe, expect, it } from "bun:test";
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
		expect(cacheKey(START_LATER, 4, 1500, { movetimeMs: 800 })).toBe(`${fenKey(START)}|4|1500|t800`);
		expect(cacheKey(START, 4, undefined, { infinite: true })).toBe(`${fenKey(START)}|4|full|inf`);
	});
});

describe("AnalysisCache", () => {
	it("returns complete results at or above the requested depth for the same fen/elo", () => {
		const c = new AnalysisCache();
		const r = result(START, 14, { elo: 1500 });
		c.set(r);
		expect(c.get(START, 4, 12, 1500)).toBe(r);
		expect(c.get(START_LATER, 4, 14, 1500)).toBe(r);
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
	it("caches every complete result, superseded ones only with a complete final iteration", () => {
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
		// a movetime search that stopped mid-iteration is still a complete result → cached;
		// get's minDepth is the quality gate
		const partial = result(OTHER, 12, { finalComplete: false });
		expect(isCacheable(partial)).toBe(true);
		c.set(partial);
		expect(c.get(OTHER, 4, 12)).toBe(partial);
		expect(c.get(OTHER, 4, 13)).toBeUndefined();
		expect(c.size).toBe(2);
	});
	it("replaces an entry with the same key", () => {
		const c = new AnalysisCache();
		c.set(result(START, 10, { id: "a" }));
		c.set(result(START_LATER, 12, { id: "b" }));
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
