// test/core/engine/uci-client.test.ts
import { describe, expect, it } from "bun:test";
import { pvToSan } from "@core/chess/san";
import { TIMINGS } from "@core/constants/timings";
import type { AnalysisUpdate } from "@core/engine/types";
import { cpEquivalent, FEATURE_DEPTH, UciEngine } from "@core/engine/uci-client";
import {
	FakeEngineTransport,
	FakeScheduler,
	flush,
	RESTART_MARKER,
} from "../../fakes/engine-transport";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

function info(depth: number, multipv: number, cp: number, pv: string, extra = ""): string {
	return `info depth ${depth} seldepth ${depth + 2} multipv ${multipv} score cp ${cp}${extra} nodes ${depth * 100} nps 50000 time ${depth * 2} pv ${pv}`;
}

// One-time warm-up (chess.js load + the client's hot paths) so first-use cost is not
// billed to whichever pure-logic test happens to run first under the 5 ms budget.
await (async () => {
	pvToSan(START, ["e2e4", "e7e5"]);
	const t = new FakeEngineTransport();
	const eng = new UciEngine(t, { scheduler: new FakeScheduler().scheduler });
	await eng.init();
	const h = eng.analyse({ id: "warm", fen: START, multiPv: 2, limit: { movetimeMs: 1 } });
	const it = h.updates[Symbol.asyncIterator]();
	t.feed(info(1, 1, 0, "e2e4 e7e5"), info(1, 2, 0, "d2d4 d7d5"), "bestmove e2e4");
	await it.next();
	await h.result;
	eng.dispose();
})();

async function setup(): Promise<{
	t: FakeEngineTransport;
	sched: FakeScheduler;
	eng: UciEngine;
}> {
	const t = new FakeEngineTransport();
	const sched = new FakeScheduler();
	const eng = new UciEngine(t, { scheduler: sched.scheduler });
	await eng.init();
	t.sent.length = 0;
	return { t, sched, eng };
}

function next(it: AsyncIterator<AnalysisUpdate>): Promise<IteratorResult<AnalysisUpdate>> {
	return it.next();
}

describe("UciEngine.init (a)", () => {
	it("resolves after uciok + readyok with parsed options", async () => {
		const t = new FakeEngineTransport();
		const sched = new FakeScheduler();
		const eng = new UciEngine(t, { scheduler: sched.scheduler });
		const p = eng.init();
		expect(eng.state()).toBe("initialising");
		const infoOut = await p;
		expect(t.sent).toEqual(["uci", "isready"]);
		expect(eng.state()).toBe("idle");
		expect(infoOut.name).toBe("Fake 1");
		expect(infoOut.author).toBe("sliced");
		expect(infoOut.options.UCI_Elo).toEqual({
			type: "spin",
			default: "1320",
			min: 1320,
			max: 3190,
		});
		expect(sched.pending).toBe(0);
	});
	it("times out waiting for uciok and reports crashed", async () => {
		const t = new FakeEngineTransport();
		t.autoReply = false;
		const sched = new FakeScheduler();
		const eng = new UciEngine(t, { scheduler: sched.scheduler });
		const p = eng.init();
		sched.advance(TIMINGS.engineReadyTimeoutMs);
		await expect(p).rejects.toThrow(/uciok/);
		expect(eng.state()).toBe("crashed");
	});
});

describe("UciEngine.analyse (b)", () => {
	it("sends setoption MultiPV, position, go in order and moves to searching", async () => {
		const { t, eng } = await setup();
		eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { movetimeMs: 800 } });
		expect(eng.state()).toBe("searching");
		expect(t.sent).toEqual([
			"setoption name MultiPV value 2",
			`position fen ${START}`,
			"go movetime 800",
		]);
	});
	it("encodes moves, searchmoves, depth+movetime, nodes, infinite and the default limit", async () => {
		const { t, eng } = await setup();
		eng.analyse({
			id: "r1",
			fen: START,
			moves: ["e2e4", "e7e5"],
			multiPv: 1,
			limit: { depth: 12, movetimeMs: 500 },
			searchmoves: ["g1f3", "b1c3"],
		});
		expect(t.sent[1]).toBe(`position fen ${START} moves e2e4 e7e5`);
		expect(t.sent[2]).toBe("go depth 12 movetime 500 searchmoves g1f3 b1c3");
		t.feed("bestmove g1f3");
		eng.analyse({ id: "r2", fen: START, multiPv: 1, limit: { nodes: 5000 } });
		expect(t.sent.at(-1)).toBe("go nodes 5000");
		t.feed("bestmove g1f3");
		eng.analyse({ id: "r3", fen: START, multiPv: 1, limit: { infinite: true } });
		expect(t.sent.at(-1)).toBe("go infinite");
		t.feed("bestmove g1f3");
		eng.analyse({ id: "r4", fen: START, multiPv: 1, limit: {} });
		expect(t.sent.at(-1)).toBe(`go movetime ${TIMINGS.analysisDefaultMovetimeMs}`);
	});
	it("yields a coalesced update when all multipv lines of a depth arrive, then resolves on bestmove", async () => {
		const { t, sched, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { movetimeMs: 800 } });
		const it = h.updates[Symbol.asyncIterator]();
		let resolved = false;
		const p1 = next(it).then((r) => {
			resolved = true;
			return r;
		});
		t.feed(info(1, 1, 30, "e2e4 e7e5"));
		await flush();
		expect(resolved).toBe(false);
		t.feed(info(1, 2, 20, "d2d4 d7d5"));
		const u = (await p1).value as AnalysisUpdate;
		expect(u.id).toBe("r1");
		expect(u.depth).toBe(1);
		expect(u.seldepth).toBe(3);
		expect(u.complete).toBe(true);
		expect(u.nodes).toBe(100);
		expect(u.nps).toBe(50000);
		expect(u.timeMs).toBe(2);
		expect(u.lines.map((l) => l.multipv)).toEqual([1, 2]);
		expect(u.lines[0]).toEqual({
			multipv: 1,
			score: { cp: 30 },
			depth: 1,
			seldepth: 3,
			pvUci: ["e2e4", "e7e5"],
			pvSan: ["e4", "e5"],
		});
		expect(u.lines[1]?.pvSan).toEqual(["d4", "d5"]);
		expect(sched.pending).toBe(1); // only the movetime watchdog
	});
	it("resolves on bestmove with the final frame, then the iterator ends", async () => {
		const { t, sched, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { movetimeMs: 800 } });
		const it = h.updates[Symbol.asyncIterator]();
		t.feed(info(1, 1, 30, "e2e4 e7e5"), info(1, 2, 20, "d2d4 d7d5"));
		t.feed("bestmove e2e4 ponder e7e5");
		const r = await h.result;
		expect(r.status).toBe("complete");
		expect(r.bestmove).toBe("e2e4");
		expect(r.ponder).toBe("e7e5");
		expect(r.final.depth).toBe(1);
		expect(r.final.complete).toBe(true);
		expect(r.engineElo).toBeUndefined();
		expect(r.request.id).toBe("r1");
		expect(eng.state()).toBe("idle");
		expect(sched.pending).toBe(0);
		// the final update is delivered, then the iterator ends
		expect((await next(it)).value?.depth).toBe(1);
		expect((await next(it)).done).toBe(true);
	});
	it("emits partial updates every engineInfoCoalesceMs (single-slot mailbox)", async () => {
		const { t, sched, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { infinite: true } });
		const it = h.updates[Symbol.asyncIterator]();
		t.feed(info(1, 1, 30, "e2e4"), info(1, 2, 20, "d2d4"));
		t.feed(info(2, 1, 35, "e2e4 e7e5"));
		// two updates are pending in the slot: the complete depth-1 frame was replaced by nothing yet
		const first = (await next(it)).value as AnalysisUpdate;
		expect(first.depth).toBe(1);
		expect(first.complete).toBe(true);
		let got: AnalysisUpdate | undefined;
		void next(it).then((r) => {
			got = r.value;
		});
		await flush();
		expect(got).toBeUndefined();
		sched.advance(TIMINGS.engineInfoCoalesceMs - 1);
		await flush();
		expect(got).toBeUndefined();
		sched.advance(1);
		await flush();
		expect(got?.depth).toBe(2);
		expect(got?.complete).toBe(false);
		expect(got?.lines.map((l) => l.depth)).toEqual([2, 1]);
		// newest wins: several partials before the consumer reads collapse into one
		t.feed(info(3, 1, 40, "e2e4"));
		sched.advance(TIMINGS.engineInfoCoalesceMs);
		t.feed(info(4, 1, 45, "e2e4"));
		sched.advance(TIMINGS.engineInfoCoalesceMs);
		expect((await next(it)).value?.depth).toBe(4);
	});
	it("ignores bound lines on multipv 1, accepts them on k > 1, never overwrites an exact score with a bound", async () => {
		const { t, sched, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { infinite: true } });
		const updates = h.updates[Symbol.asyncIterator]();
		t.feed(info(3, 1, 30, "e2e4"), info(3, 2, 20, "d2d4"));
		t.feed(info(3, 1, 99, "e2e4", " upperbound"));
		t.feed(info(3, 2, 99, "d2d4", " upperbound"));
		t.feed(info(4, 2, 15, "c2c4", " upperbound"));
		sched.advance(TIMINGS.engineInfoCoalesceMs);
		const streamed = (await next(updates)).value as AnalysisUpdate;
		expect(streamed.lines[0]?.score).toEqual({ cp: 30 });
		expect(streamed.lines[1]?.score).toEqual({ cp: 15 });
		expect(streamed.lines[1]?.bound).toBe("upper");
		expect(streamed.depth).toBe(4);
		expect(streamed.complete).toBe(false);
		t.feed("bestmove e2e4");
		const r = await h.result;
		expect(r.final.lines[0]?.score).toEqual({ cp: 30 });
		expect(r.final.lines[1]?.score).toEqual({ cp: 20 });
		expect(r.final.lines[1]?.bound).toBeUndefined();
		expect(r.final.depth).toBe(3);
		expect(r.final.complete).toBe(true);
	});
	it("ignores info string / currmove lines and handles bestmove (none)", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 100 } });
		t.feed(
			"info string NNUE evaluation using nn-1.nnue",
			"info depth 5 currmove e2e4 currmovenumber 1"
		);
		t.feed("info depth 0 score mate 0");
		t.feed("bestmove (none)");
		const r = await h.result;
		expect(r.bestmove).toBeNull();
		expect(r.final.lines).toEqual([]);
		expect(r.final.depth).toBe(0);
	});
	it("maps mate scores and wdl into EvalLine", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 100 } });
		t.feed("info depth 6 multipv 1 score mate 3 wdl 1000 0 0 nodes 1 nps 1 time 1 pv e2e4");
		t.feed("bestmove e2e4");
		const r = await h.result;
		expect(r.final.lines[0]?.score).toEqual({ mate: 3 });
		expect(r.final.lines[0]?.wdl).toEqual([1000, 0, 0]);
	});
	it("sends UCI_LimitStrength/UCI_Elo/MultiPV per request only when they change", async () => {
		const { t, eng } = await setup();
		eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 100 }, elo: 1500 });
		expect(t.sent.slice(0, 3)).toEqual([
			"setoption name UCI_LimitStrength value true",
			"setoption name UCI_Elo value 1500",
			"setoption name MultiPV value 1",
		]);
		t.feed("bestmove e2e4");
		t.sent.length = 0;
		const h2 = eng.analyse({
			id: "r2",
			fen: START,
			multiPv: 1,
			limit: { movetimeMs: 100 },
			elo: 1500,
		});
		// nothing changed (same elo, same MultiPV): no setoption at all before position
		expect(t.sent[0]).toBe(`position fen ${START}`);
		t.feed("bestmove e2e4");
		expect((await h2.result).engineElo).toBe(1500);
		t.sent.length = 0;
		eng.analyse({ id: "r3", fen: START, multiPv: 1, limit: { movetimeMs: 100 } });
		expect(t.sent[0]).toBe("setoption name UCI_LimitStrength value false");
	});
	it("queues requests made before init and starts them once idle", async () => {
		const t = new FakeEngineTransport();
		const sched = new FakeScheduler();
		const eng = new UciEngine(t, { scheduler: sched.scheduler });
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 100 } });
		expect(t.sent).toEqual([]);
		await eng.init();
		expect(eng.state()).toBe("searching");
		expect(t.sent.at(-1)).toBe("go movetime 100");
		t.feed("bestmove e2e4");
		expect((await h.result).status).toBe("complete");
	});
	it("stops a movetime search that overruns its budget by the stop timeout", async () => {
		const { t, sched, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 800 } });
		sched.advance(800 + TIMINGS.engineStopTimeoutMs - 1);
		expect(t.sent).not.toContain("stop");
		sched.advance(1);
		expect(t.sent.at(-1)).toBe("stop");
		expect(eng.state()).toBe("stopping");
		t.feed("bestmove e2e4");
		expect((await h.result).status).toBe("complete");
	});
});

describe("UciEngine completed MultiPV integrity", () => {
	it("keeps a completed cycle when stop interrupts the next depth, retaining final search totals", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "cycle", fen: START, multiPv: 3, limit: { infinite: true } });
		t.feed(
			"info depth 14 seldepth 20 multipv 1 score cp 38 nodes 19000 nps 95000 time 200 pv e2e4 e7e5",
			"info depth 14 seldepth 18 multipv 2 score cp 30 nodes 19000 nps 95000 time 200 pv d2d4 d7d5",
			"info depth 14 seldepth 19 multipv 3 score cp 25 nodes 19000 nps 95000 time 200 pv g1f3 g8f6",
			"info depth 15 seldepth 22 multipv 1 score cp 40 nodes 28000 nps 93333 time 300 pv d2d4 d7d5"
		);
		const stopped = h.stop();
		t.feed("info nodes 31000 nps 88571 time 350", "bestmove d2d4 ponder d7d5");
		await stopped;
		const result = await h.result;
		expect(result.bestmove).toBe("d2d4");
		expect(result.final.depth).toBe(14);
		expect(result.final.complete).toBe(true);
		expect(result.final.lines.map((line) => line.depth)).toEqual([14, 14, 14]);
		expect(result.final.lines.map((line) => line.pvUci[0])).toEqual(["e2e4", "d2d4", "g1f3"]);
		expect(result.final.nodes).toBe(31000);
		expect(result.final.nps).toBe(88571);
		expect(result.final.timeMs).toBe(350);
		expect(result.final.seldepth).toBe(20);
	});

	it("does not splice a same-depth replacement root into the previous output cycle", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "same-depth", fen: START, multiPv: 2, limit: { infinite: true } });
		t.feed(info(12, 1, 50, "e2e4"), info(12, 2, 30, "d2d4"));
		t.feed(info(12, 1, 40, "g1f3"), "bestmove g1f3");
		const result = await h.result;
		expect(result.final.lines.map((line) => line.pvUci[0])).toEqual(["e2e4", "d2d4"]);
		expect(result.final.lines.map((line) => line.score.cp)).toEqual([50, 30]);
		expect(result.final.complete).toBe(true);
	});

	it("rejects the score-reordered final output after Skill promotes a weaker root", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({
			id: "skill",
			fen: START,
			multiPv: 3,
			elo: 1500,
			limit: { infinite: true },
		});
		t.feed(info(13, 1, 37, "e2e4"), info(13, 2, 30, "d2d4"), info(13, 3, 22, "g1f3"));
		t.feed(info(13, 1, 22, "g1f3"), info(13, 2, 30, "d2d4"), info(13, 3, 37, "e2e4"));
		t.feed("bestmove g1f3");
		const result = await h.result;
		expect(result.bestmove).toBe("g1f3");
		expect(result.final.lines.map((line) => line.score.cp)).toEqual([37, 30, 22]);
		expect(result.final.lines.map((line) => line.pvUci[0])).toEqual(["e2e4", "d2d4", "g1f3"]);
	});

	it("rejects duplicate roots, skipped indices, and mixed-depth cycles", async () => {
		for (const tail of [
			[info(11, 1, 40, "e2e4"), info(11, 2, 30, "e2e4"), info(11, 3, 20, "g1f3")],
			[info(11, 1, 40, "e2e4"), info(11, 3, 30, "d2d4"), info(11, 4, 20, "g1f3")],
			[info(11, 1, 40, "e2e4"), info(10, 2, 30, "d2d4"), info(10, 3, 20, "g1f3")],
		]) {
			const { t, eng } = await setup();
			const h = eng.analyse({
				id: "invalid-cycle",
				fen: START,
				multiPv: 3,
				limit: { infinite: true },
			});
			t.feed(info(10, 1, 35, "e2e4"), info(10, 2, 25, "d2d4"), info(10, 3, 15, "g1f3"));
			t.feed(...tail, "bestmove e2e4");
			const result = await h.result;
			expect(result.final.depth).toBe(10);
			expect(result.final.lines.map((line) => line.score.cp)).toEqual([35, 25, 15]);
			expect(new Set(result.final.lines.map((line) => line.pvUci[0])).size).toBe(3);
			eng.dispose();
		}
	});

	it("does not regress to a later complete output cycle from an older depth", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "regression", fen: START, multiPv: 2, limit: { infinite: true } });
		t.feed(info(14, 1, 60, "e2e4"), info(14, 2, 50, "d2d4"));
		t.feed(info(12, 1, 30, "d2d4"), info(12, 2, 20, "e2e4"), "bestmove d2d4");
		const result = await h.result;
		expect(result.final.depth).toBe(14);
		expect(result.final.lines.map((line) => line.score.cp)).toEqual([60, 50]);
		expect(result.final.timeMs).toBe(28);
		expect(result.final.nodes).toBe(1400);
	});

	it("retains only usable exact partial lines when no full cycle completed", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "partial", fen: START, multiPv: 3, limit: { infinite: true } });
		t.feed(info(10, 1, 40, "e2e4"), info(10, 2, 30, "d2d4"));
		t.feed(info(10, 3, 20, "g1f3", " upperbound"));
		t.feed(info(11, 1, 99, "e2e5"), info(11, 2, 20, "e2e4")); // illegal root, then orphan index
		t.feed("bestmove e2e4");
		const result = await h.result;
		expect(result.final.complete).toBe(false);
		expect(result.final.depth).toBe(10);
		expect(result.final.lines.map((line) => line.pvUci[0])).toEqual(["e2e4", "d2d4"]);
		expect(result.final.lines.every((line) => line.bound === undefined)).toBe(true);
		expect(result.final.timeMs).toBe(22);
	});

	it("recognizes a forced move after applying the request's move history", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({
			id: "forced",
			fen: "7k/5K2/8/6R1/8/8/8/8 w - - 0 1",
			moves: ["g5g6"],
			multiPv: 4,
			limit: { infinite: true },
		});
		t.feed(info(12, 1, -500, "h8h7"), "bestmove h8h7");
		const result = await h.result;
		expect(result.final.complete).toBe(true);
		expect(result.final.lines).toHaveLength(1);
		expect(result.final.lines[0]?.pvSan).toEqual(["Kh7"]);
	});

	it("counts unique legal searchmoves rather than requiring the requested MultiPV count", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({
			id: "restricted",
			fen: START,
			multiPv: 4,
			searchmoves: ["e2e4", "e2e4", "d2d4", "e2e5"],
			limit: { infinite: true },
		});
		t.feed(info(12, 1, 30, "e2e4"), info(12, 2, 20, "d2d4"), "bestmove e2e4");
		const result = await h.result;
		expect(result.final.complete).toBe(true);
		expect(result.final.lines).toHaveLength(2);
	});

	it("orders mate scores correctly relative to extreme cp and longer losing mates", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "mates", fen: START, multiPv: 4, limit: { infinite: true } });
		t.feed(
			"info depth 8 multipv 1 score mate 3 pv e2e4",
			"info depth 8 multipv 2 score cp 30000 pv d2d4",
			"info depth 8 multipv 3 score mate -8 pv g1f3",
			"info depth 8 multipv 4 score mate -2 pv b1c3",
			"bestmove e2e4"
		);
		expect((await h.result).final.complete).toBe(true);
	});
});

describe("UciEngine queue and supersede (c)", () => {
	it("a second analyse while searching sends stop; the first resolves superseded, the second runs after bestmove", async () => {
		const { t, eng } = await setup();
		const h1 = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 800 } });
		t.feed(info(3, 1, 30, "e2e4"));
		const h2 = eng.analyse({ id: "r2", fen: AFTER_E4, multiPv: 1, limit: { movetimeMs: 800 } });
		expect(t.sent.at(-1)).toBe("stop");
		expect(eng.state()).toBe("stopping");
		expect(t.sent.filter((l) => l.startsWith("position")).length).toBe(1);
		t.feed("bestmove e2e4");
		const r1 = await h1.result;
		expect(r1.status).toBe("superseded");
		expect(r1.bestmove).toBe("e2e4");
		expect(r1.final.depth).toBe(3);
		expect(eng.state()).toBe("searching");
		expect(t.sent.slice(-2)).toEqual([`position fen ${AFTER_E4}`, "go movetime 800"]);
		t.feed("bestmove e7e5");
		expect((await h2.result).status).toBe("complete");
		expect(eng.state()).toBe("idle");
	});
	it("orders the queue move > ponder > panel and only interrupts for equal or higher priority", async () => {
		const { t, eng } = await setup();
		const hMove = eng.analyse({ id: "m1", fen: START, multiPv: 1, limit: { movetimeMs: 800 } });
		eng.analyse({ id: "p1", fen: START, multiPv: 1, limit: { infinite: true }, priority: "panel" });
		const hPonder = eng.ponder(AFTER_E4, [], 4);
		expect(t.sent).not.toContain("stop");
		t.feed("bestmove e2e4");
		expect((await hMove.result).status).toBe("complete");
		expect(t.sent.slice(-3)).toEqual([
			"setoption name MultiPV value 4",
			`position fen ${AFTER_E4}`,
			"go infinite",
		]);
		// a move request supersedes the running ponder
		const hMove2 = eng.analyse({ id: "m2", fen: AFTER_E4, multiPv: 1, limit: { movetimeMs: 500 } });
		expect(t.sent.at(-1)).toBe("stop");
		t.feed("bestmove e7e5");
		expect((await hPonder.result).status).toBe("superseded");
		expect(t.sent.at(-1)).toBe("go movetime 500");
		t.feed("bestmove g1f3");
		expect((await hMove2.result).status).toBe("complete");
		expect(t.sent.at(-1)).toBe("go infinite"); // the panel request finally runs
	});
	it("handle.stop() on the active search resolves after bestmove with status complete", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { infinite: true } });
		let stopped = false;
		const p = h.stop().then(() => {
			stopped = true;
		});
		expect(t.sent.at(-1)).toBe("stop");
		await flush();
		expect(stopped).toBe(false);
		t.feed("bestmove e2e4");
		await p;
		expect((await h.result).status).toBe("complete");
		await h.stop(); // idempotent once finished
	});
	it("handle.stop() on a queued request removes it and resolves superseded", async () => {
		const { t, eng } = await setup();
		eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { infinite: true } });
		const h2 = eng.analyse({
			id: "r2",
			fen: START,
			multiPv: 1,
			limit: { infinite: true },
			priority: "panel",
		});
		await h2.stop();
		expect((await h2.result).status).toBe("superseded");
		t.feed("bestmove e2e4");
		await flush();
		expect(eng.state()).toBe("idle");
		expect(t.sent.filter((l) => l.startsWith("go")).length).toBe(1);
	});
	it("stops a ponder search at ponderMaxMs", async () => {
		const { t, sched, eng } = await setup();
		eng.ponder(START, ["e2e4"], 4);
		expect(t.sent.at(-2)).toBe(`position fen ${START} moves e2e4`);
		sched.advance(TIMINGS.ponderMaxMs);
		expect(t.sent.at(-1)).toBe("stop");
	});
});

describe("UciEngine crash and recovery (d)", () => {
	it("fails the active request, replays options in order after restart, and drains the queue", async () => {
		const { t, eng } = await setup();
		await eng.setOptions({ Hash: 32, Threads: 2 });
		await eng.setOptions({ Hash: 64 });
		const h1 = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { movetimeMs: 800 } });
		const h2 = eng.analyse({
			id: "r2",
			fen: AFTER_E4,
			multiPv: 1,
			limit: { movetimeMs: 800 },
			priority: "panel",
		});
		const mark = t.sent.length;
		t.crash();
		expect(eng.state()).toBe("crashed");
		const r1 = await h1.result;
		expect(r1.status).toBe("failed");
		expect(r1.bestmove).toBeNull();
		await flush();
		expect(t.restarts).toBe(1);
		expect(t.since(mark)).toEqual([
			RESTART_MARKER,
			"uci",
			"setoption name Threads value 2",
			"setoption name Hash value 64",
			"setoption name MultiPV value 2",
			"ucinewgame",
			"isready",
			"setoption name MultiPV value 1",
			`position fen ${AFTER_E4}`,
			"go movetime 800",
		]);
		expect(eng.state()).toBe("searching");
		t.feed("bestmove e7e5");
		expect((await h2.result).status).toBe("complete");
	});
	it("fails queued requests when the restart itself fails", async () => {
		const { t, eng } = await setup();
		t.restartImpl = () => Promise.reject(new Error("no worker"));
		const h1 = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 800 } });
		const h2 = eng.analyse({ id: "r2", fen: START, multiPv: 1, limit: { movetimeMs: 800 } });
		t.crash();
		expect((await h1.result).status).toBe("failed");
		expect((await h2.result).status).toBe("failed");
		await flush();
		expect(eng.state()).toBe("crashed");
	});
	it("ignores a crash signal while already recovering", async () => {
		const { t, eng } = await setup();
		eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 800 } });
		t.crash();
		t.crash();
		await flush();
		expect(t.restarts).toBe(1);
		expect(eng.state()).toBe("idle");
	});
});

describe("UciEngine: a handshake that fails without crashing (Fix G round 2)", () => {
	// `analyse` before `init()` resolves is *queued* (`pump` bails on `!initialised`). Every way the
	// handshake can fail must therefore settle that queue, because the caller above it
	// (`RecommendationPipeline.runSearch` awaits `handle.result`) has no timeout of its own: an
	// unsettled promise leaves the session in `live:my-turn:analysing` behind a non-null
	// `pipelineAc` for the rest of the game, and at ply 0 as white no later position arrives to
	// reset it. A promise that never settles is worse than any early return.
	//
	// The *timeout* legs are covered: `sendAndWait`'s timer calls `onCrash`, which fails the queue.
	// A synchronous `transport.send` throw is the leg that is not — it rejects the waiter directly,
	// and `handshake`'s catch only marks the state. `EngineTransport.send` is a `void` sync API and
	// the client already defends against it throwing, so this is a contract hole, not a theory.
	it("settles requests queued before a handshake the transport breaks synchronously", async () => {
		const t = new FakeEngineTransport();
		const sched = new FakeScheduler();
		const eng = new UciEngine(t, { scheduler: sched.scheduler });
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 100 } });
		// Probed rather than awaited: an unsettled promise would hang the test instead of failing it.
		const settled: Array<Awaited<typeof h.result>> = [];
		void h.result.then((r) => void settled.push(r));
		const send = t.send.bind(t);
		t.send = (line: string): void => {
			if (line === "uci") throw new Error("port closed");
			send(line);
		};

		await expect(eng.init()).rejects.toThrow(/port closed/);
		expect(eng.state()).toBe("crashed");
		await flush();

		expect(settled).toHaveLength(1);
		expect(settled[0]?.status).toBe("failed");
		expect(settled[0]?.bestmove).toBeNull();
		expect(settled[0]?.request.id).toBe("r1");
		// The iterator ends too, so an `updates` consumer is not left hanging either.
		const it = h.updates[Symbol.asyncIterator]();
		expect((await next(it)).value?.id).toBe("r1");
		expect((await next(it)).done).toBe(true);
		// It was never dispatched: the engine never became usable.
		expect(t.sent.filter((l) => l.startsWith("go"))).toEqual([]);
		expect(sched.pending).toBe(0);
	});

	it("a later init still succeeds and serves new requests", async () => {
		// Failing the queue must not poison the engine: the panel's "Restart engine" (and an
		// offscreen document that comes up late) has to work afterwards.
		const t = new FakeEngineTransport();
		const sched = new FakeScheduler();
		const eng = new UciEngine(t, { scheduler: sched.scheduler });
		const dead = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 100 } });
		const send = t.send.bind(t);
		let broken = true;
		t.send = (line: string): void => {
			if (broken && line === "uci") throw new Error("port closed");
			send(line);
		};
		await expect(eng.init()).rejects.toThrow(/port closed/);
		expect((await dead.result).status).toBe("failed");

		broken = false;
		expect((await eng.init()).name).toBe("Fake 1");
		expect(eng.state()).toBe("idle");
		const h = eng.analyse({ id: "r2", fen: START, multiPv: 1, limit: { movetimeMs: 100 } });
		expect(t.sent.at(-1)).toBe("go movetime 100");
		t.feed("bestmove e2e4");
		expect((await h.result).status).toBe("complete");
		eng.dispose();
	});

	it("the timeout legs already settle the queue through onCrash", async () => {
		// Recorded because round 1 of this lane reported the timeout leg as the hole and it is not:
		// `sendAndWait`'s timer calls `onCrash`, which fails the queue. This is the production
		// "the offscreen document never answers" path (`RemoteEngine.post` never throws), so it is
		// the one that matters most — and it is already covered. The assertion is here so a future
		// change to `sendAndWait` cannot quietly remove that coverage.
		const t = new FakeEngineTransport();
		t.autoReply = false;
		const sched = new FakeScheduler();
		const eng = new UciEngine(t, { scheduler: sched.scheduler });
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 100 } });
		const p = eng.init();
		sched.advance(TIMINGS.engineReadyTimeoutMs);
		await expect(p).rejects.toThrow(/uciok/);
		expect((await h.result).status).toBe("failed");
		expect(eng.state()).toBe("crashed");
	});
});

describe("UciEngine after an unrecovered crash", () => {
	it("fails new requests immediately instead of queueing them forever", async () => {
		const { t, eng } = await setup();
		t.restartImpl = () => Promise.reject(new Error("no worker"));
		eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 800 } });
		t.crash();
		await flush();
		expect(eng.state()).toBe("crashed");
		const h = eng.analyse({ id: "r2", fen: START, multiPv: 1, limit: { movetimeMs: 800 } });
		const r = await h.result;
		expect(r.status).toBe("failed");
		expect(r.bestmove).toBeNull();
		const it = h.updates[Symbol.asyncIterator]();
		expect((await next(it)).value?.id).toBe("r2"); // the (empty) final frame
		expect((await next(it)).done).toBe(true);
		expect(t.sent.filter((l) => l.startsWith("go")).length).toBe(1);
	});
	it("refuses init() while a recovery is in flight, then accepts it after a failed recovery", async () => {
		const { t, eng } = await setup();
		let fail: () => void = () => {};
		t.restartImpl = () =>
			new Promise<void>((_, reject) => {
				fail = () => reject(new Error("worker gone"));
			});
		eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 800 } });
		t.crash();
		await expect(eng.init()).rejects.toThrow(/recovery in progress/);
		fail(); // the restart itself fails: recovery gives up
		await flush();
		expect(eng.state()).toBe("crashed");
		const info = await eng.init();
		expect(info.name).toBe("Fake 1");
		expect(eng.state()).toBe("idle");
	});
	it("cleans up the waiter when the transport throws synchronously on send", async () => {
		const t = new FakeEngineTransport();
		const sched = new FakeScheduler();
		const eng = new UciEngine(t, { scheduler: sched.scheduler });
		const send = t.send.bind(t);
		t.send = (line: string) => {
			if (line === "uci") throw new Error("port closed");
			send(line);
		};
		await expect(eng.init()).rejects.toThrow(/port closed/);
		expect(sched.pending).toBe(0);
		expect(eng.state()).toBe("crashed");
	});
});

describe("UciEngine ponder interruption", () => {
	it("a panel request interrupts a running ponder", async () => {
		const { t, eng } = await setup();
		const hPonder = eng.ponder(START, [], 4);
		expect(t.sent.at(-1)).toBe("go infinite");
		const hPanel = eng.analyse({
			id: "p1",
			fen: AFTER_E4,
			multiPv: 1,
			limit: { infinite: true },
			priority: "panel",
		});
		expect(t.sent.at(-1)).toBe("stop");
		t.feed("bestmove e2e4");
		expect((await hPonder.result).status).toBe("superseded");
		expect(t.sent.slice(-2)).toEqual([`position fen ${AFTER_E4}`, "go infinite"]);
		t.feed("bestmove e7e5");
		expect((await hPanel.result).status).toBe("complete");
	});
});

describe("UciEngine stop timeout (e)", () => {
	it("treats a missing bestmove after engineStopTimeoutMs as a crash and recovers", async () => {
		const { t, sched, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { infinite: true } });
		void h.stop();
		expect(eng.state()).toBe("stopping");
		sched.advance(TIMINGS.engineStopTimeoutMs - 1);
		expect(eng.state()).toBe("stopping");
		sched.advance(1);
		expect(eng.state()).toBe("crashed");
		expect((await h.result).status).toBe("failed");
		await flush();
		expect(t.restarts).toBe(1);
		expect(eng.state()).toBe("idle");
	});
});

describe("UciEngine atFeatureDepth (f)", () => {
	it("captures the last complete depth-10 iteration even when the search goes deeper", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { movetimeMs: 800 } });
		t.feed(info(9, 1, 10, "e2e4"), info(9, 2, 5, "d2d4"));
		t.feed(info(FEATURE_DEPTH, 1, 20, "e2e4"), info(FEATURE_DEPTH, 2, 15, "d2d4"));
		t.feed(info(FEATURE_DEPTH, 1, 22, "e2e4 e7e5")); // a new incomplete output cycle
		t.feed(info(11, 1, 30, "e2e4"), info(11, 2, 25, "d2d4"));
		t.feed(info(12, 1, 33, "e2e4"));
		t.feed("bestmove e2e4");
		const r = await h.result;
		expect(r.final.depth).toBe(11);
		expect(r.atFeatureDepth?.depth).toBe(FEATURE_DEPTH);
		expect(r.atFeatureDepth?.complete).toBe(true);
		expect(r.atFeatureDepth?.lines.map((l) => l.score.cp)).toEqual([20, 15]);
	});
	// H4 (2026-09-13): the rule is "the first complete frame at or past the requested depth" — a
	// depth the engine never completes (an aspiration re-search can skip a MultiPV cycle) is
	// answered by the next one that does, never by the deepest one that does not exceed it.
	it("captures the next complete depth when depth 10 itself never completed", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { movetimeMs: 800 } });
		t.feed(info(9, 1, 10, "e2e4"), info(9, 2, 5, "d2d4"));
		t.feed(info(10, 1, 20, "e2e4"));
		t.feed(info(11, 1, 30, "e2e4"), info(11, 2, 25, "d2d4"));
		t.feed(info(12, 1, 33, "e2e4"), info(12, 2, 31, "d2d4"));
		t.feed("bestmove e2e4");
		const r = await h.result;
		expect(r.atFeatureDepth?.depth).toBe(11);
		expect(r.atFeatureDepth?.complete).toBe(true);
		expect(r.atFeatureDepth?.lines.map((l) => l.score.cp)).toEqual([30, 25]);
	});
	it("is undefined when nothing at or past depth 10 completed", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { movetimeMs: 800 } });
		t.feed(info(9, 1, 10, "e2e4"), info(9, 2, 5, "d2d4"));
		t.feed(info(10, 1, 20, "e2e4"));
		t.feed(info(11, 1, 30, "e2e4"));
		t.feed("bestmove e2e4");
		expect((await h.result).atFeatureDepth).toBeUndefined();
	});
	it("honours the request's featureDepth: the first complete frame at or past it", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({
			id: "r1",
			fen: START,
			multiPv: 2,
			limit: { movetimeMs: 800 },
			featureDepth: 4,
		});
		t.feed(info(3, 1, 8, "e2e4"), info(3, 2, 4, "d2d4"));
		t.feed(info(4, 1, 12, "e2e4"), info(4, 2, 9, "d2d4"));
		t.feed(info(5, 1, 14, "e2e4"), info(5, 2, 11, "d2d4"));
		t.feed(info(FEATURE_DEPTH, 1, 20, "e2e4"), info(FEATURE_DEPTH, 2, 15, "d2d4"));
		t.feed("bestmove e2e4");
		const r = await h.result;
		expect(r.final.depth).toBe(FEATURE_DEPTH);
		expect(r.atFeatureDepth?.depth).toBe(4);
		expect(r.atFeatureDepth?.lines.map((l) => l.score.cp)).toEqual([12, 9]);
		expect(r.request.featureDepth).toBe(4);
	});
	it("a requested depth the search skipped is answered by the next complete one", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({
			id: "r1",
			fen: START,
			multiPv: 2,
			limit: { movetimeMs: 800 },
			featureDepth: 4,
		});
		t.feed(info(3, 1, 8, "e2e4"), info(3, 2, 4, "d2d4"));
		t.feed(info(4, 1, 12, "e2e4")); // never completes
		t.feed(info(6, 1, 16, "e2e4"), info(6, 2, 13, "d2d4"));
		t.feed(info(7, 1, 18, "e2e4"), info(7, 2, 14, "d2d4"));
		t.feed("bestmove e2e4");
		const r = await h.result;
		expect(r.atFeatureDepth?.depth).toBe(6);
		expect(r.atFeatureDepth?.lines.map((l) => l.score.cp)).toEqual([16, 13]);
	});
	it("a re-emitted cycle at the captured depth refreshes it; a deeper one never replaces it", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({
			id: "r1",
			fen: START,
			multiPv: 2,
			limit: { movetimeMs: 800 },
			featureDepth: 4,
		});
		t.feed(info(4, 1, 12, "e2e4"), info(4, 2, 9, "d2d4"));
		t.feed(info(4, 1, 13, "e2e4"), info(4, 2, 10, "d2d4"));
		t.feed(info(5, 1, 14, "e2e4"), info(5, 2, 11, "d2d4"));
		t.feed("bestmove e2e4");
		const r = await h.result;
		expect(r.atFeatureDepth?.depth).toBe(4);
		expect(r.atFeatureDepth?.lines.map((l) => l.score.cp)).toEqual([13, 10]);
	});
});

describe("UciEngine.setOptions / newGame", () => {
	it("diffs against applied options and waits for readyok", async () => {
		const { t, eng } = await setup();
		let done = false;
		t.autoReply = false;
		const p = eng.setOptions({ Hash: 32, Threads: 2, UCI_ShowWDL: true }).then(() => {
			done = true;
		});
		expect(t.sent).toEqual([
			"setoption name Hash value 32",
			"setoption name Threads value 2",
			"setoption name UCI_ShowWDL value true",
			"isready",
		]);
		await flush();
		expect(done).toBe(false);
		t.feed("readyok");
		await p;
		t.sent.length = 0;
		await eng.setOptions({ Hash: 32 });
		expect(t.sent).toEqual([]);
		t.autoReply = true;
		await eng.setOptions({ Hash: 64, Threads: 2 });
		expect(t.sent).toEqual(["setoption name Hash value 64", "isready"]);
	});
	it("is refused while searching", async () => {
		const { t, eng } = await setup();
		eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { infinite: true } });
		await expect(eng.setOptions({ Hash: 32 })).rejects.toThrow(/searching/);
		await expect(eng.newGame()).rejects.toThrow(/searching/);
		expect(t.sent).not.toContain("ucinewgame");
	});
	it("newGame sends ucinewgame + isready and defers a queued search until readyok", async () => {
		const { t, eng } = await setup();
		t.autoReply = false;
		const p = eng.newGame();
		eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { movetimeMs: 100 } });
		expect(t.sent).toEqual(["ucinewgame", "isready"]);
		t.feed("readyok");
		await p;
		expect(t.sent.at(-1)).toBe("go movetime 100");
	});
	it("serialises concurrent option bursts", async () => {
		const { t, eng } = await setup();
		const a = eng.setOptions({ Hash: 32 });
		const b = eng.setOptions({ Threads: 2 });
		await Promise.all([a, b]);
		expect(t.sent).toEqual([
			"setoption name Hash value 32",
			"isready",
			"setoption name Threads value 2",
			"isready",
		]);
	});
	it("is refused before init", async () => {
		const eng = new UciEngine(new FakeEngineTransport(), {
			scheduler: new FakeScheduler().scheduler,
		});
		await expect(eng.setOptions({ Hash: 32 })).rejects.toThrow(/initialised/);
	});
});

describe("UciEngine.dispose", () => {
	it("fails outstanding requests and stops listening", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 1, limit: { infinite: true } });
		eng.dispose();
		expect((await h.result).status).toBe("failed");
		t.feed("bestmove e2e4");
		t.crash();
		await flush();
		expect(t.restarts).toBe(0);
	});
});

describe("cpEquivalent", () => {
	it("passes cp through and maps mate to ±(2000 − 10·plies)", () => {
		expect(cpEquivalent({ cp: 34 })).toBe(34);
		expect(cpEquivalent({ cp: -120 })).toBe(-120);
		expect(cpEquivalent({ mate: 1 })).toBe(1990);
		expect(cpEquivalent({ mate: 3 })).toBe(1950);
		expect(cpEquivalent({ mate: -1 })).toBe(-1980);
		expect(cpEquivalent({ mate: -2 })).toBe(-1960);
		expect(cpEquivalent({ mate: 0 })).toBe(-2000);
		expect(cpEquivalent({})).toBe(0);
	});
});
