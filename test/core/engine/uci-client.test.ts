// test/core/engine/uci-client.test.ts
import { describe, expect, it } from "bun:test";
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
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { infinite: true } });
		t.feed(info(3, 1, 30, "e2e4"), info(3, 2, 20, "d2d4"));
		t.feed(info(3, 1, 99, "e2e4", " upperbound"));
		t.feed(info(3, 2, 99, "d2d4", " upperbound"));
		t.feed(info(4, 2, 15, "c2c4", " upperbound"));
		t.feed("bestmove e2e4");
		const r = await h.result;
		expect(r.final.lines[0]?.score).toEqual({ cp: 30 });
		expect(r.final.lines[1]?.score).toEqual({ cp: 15 });
		expect(r.final.lines[1]?.bound).toBe("upper");
		expect(r.final.depth).toBe(4);
		expect(r.final.complete).toBe(false);
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
	it("sends UCI_LimitStrength/UCI_Elo per request only when they change", async () => {
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
		expect(t.sent[0]).toBe("setoption name MultiPV value 1");
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
		t.feed(info(FEATURE_DEPTH, 1, 22, "e2e4 e7e5")); // PV change within the same iteration
		t.feed(info(11, 1, 30, "e2e4"), info(11, 2, 25, "d2d4"));
		t.feed(info(12, 1, 33, "e2e4"));
		t.feed("bestmove e2e4");
		const r = await h.result;
		expect(r.final.depth).toBe(12);
		expect(r.atFeatureDepth?.depth).toBe(FEATURE_DEPTH);
		expect(r.atFeatureDepth?.complete).toBe(true);
		expect(r.atFeatureDepth?.lines.map((l) => l.score.cp)).toEqual([22, 15]);
	});
	it("is undefined when depth 10 never completed", async () => {
		const { t, eng } = await setup();
		const h = eng.analyse({ id: "r1", fen: START, multiPv: 2, limit: { movetimeMs: 800 } });
		t.feed(info(10, 1, 20, "e2e4"));
		t.feed(info(11, 1, 30, "e2e4"), info(11, 2, 25, "d2d4"));
		t.feed("bestmove e2e4");
		expect((await h.result).atFeatureDepth).toBeUndefined();
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
