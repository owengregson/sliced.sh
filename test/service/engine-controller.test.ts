// test/service/engine-controller.test.ts
import { describe, expect, it } from "bun:test";
import { pvToSan } from "@core/chess/san";
import { AnalysisCache } from "@core/engine/analysis-cache";
import type { AnalysisHandle, AnalysisRequest } from "@core/engine/types";
import { FEATURE_DEPTH, UciEngine } from "@core/engine/uci-client";
import { EngineController, type EngineControllerDeps } from "@service/engine-controller";
import { DEFAULT_SETTINGS, type Settings } from "@typedefs/settings";
import { FakeEngineTransport, FakeScheduler, flush } from "../fakes/engine-transport";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const AFTER_D4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1";
/** chess.js omits an en-passant square no pawn can use; this is `applyMoves(START, ["e2e4"])`. */
const AFTER_E4_NORMALISED = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

const REFERENCE_OPTION_LINES = [
	"setoption name Threads value 4",
	"setoption name Hash value 32",
	"setoption name MultiPV value 6",
	"setoption name UCI_LimitStrength value true",
	"setoption name UCI_Elo value 1500",
	"setoption name UCI_ShowWDL value true",
	"setoption name Ponder value false",
];

pvToSan(START, ["e2e4"]);

/** In-memory stand-in for `getSettings` / `onSettingsChanged`. */
class SettingsSource {
	current: Settings;
	private readonly subs = new Set<(s: Settings) => void>();
	constructor(initial: Settings) {
		this.current = initial;
	}
	getSettings = (): Promise<Settings> => Promise.resolve(this.current);
	onSettingsChanged = (cb: (s: Settings) => void): (() => void) => {
		this.subs.add(cb);
		return () => this.subs.delete(cb);
	};
	get subscribers(): number {
		return this.subs.size;
	}
	emit(next: Settings): void {
		this.current = next;
		for (const cb of [...this.subs]) cb(next);
	}
}

function settings(
	patch: { engine?: Partial<Settings["engine"]>; targetElo?: number } = {}
): Settings {
	return {
		...DEFAULT_SETTINGS,
		strength: { ...DEFAULT_SETTINGS.strength, targetElo: patch.targetElo ?? 1500 },
		engine: { ...DEFAULT_SETTINGS.engine, hashMb: 32, multiPv: 6, ...patch.engine },
	};
}

interface Rig {
	t: FakeEngineTransport;
	sched: FakeScheduler;
	eng: UciEngine;
	src: SettingsSource;
	cache: AnalysisCache;
	ctrl: EngineController;
}

async function setup(
	opts: { init?: boolean; settings?: Settings; deps?: Partial<EngineControllerDeps> } = {}
): Promise<Rig> {
	const t = new FakeEngineTransport();
	const sched = new FakeScheduler();
	const eng = new UciEngine(t, { scheduler: sched.scheduler });
	if (opts.init !== false) await eng.init();
	const src = new SettingsSource(opts.settings ?? settings());
	const cache = new AnalysisCache();
	const ctrl = new EngineController(eng, {
		getSettings: src.getSettings,
		onSettingsChanged: src.onSettingsChanged,
		env: { hardwareConcurrency: 8, sab: true },
		cache,
		now: sched.nowFn,
		...opts.deps,
	});
	await ctrl.ready;
	await flush();
	return { t, sched, eng, src, cache, ctrl };
}

function req(patch: Partial<AnalysisRequest> & { id: string; fen: string }): AnalysisRequest {
	return { multiPv: 2, limit: { infinite: true }, ...patch };
}

function infoLine(depth: number, multipv: number, cp: number, pv: string): string {
	return `info depth ${depth} multipv ${multipv} score cp ${cp} nodes ${depth * 100} nps 50000 time ${depth * 2} pv ${pv}`;
}

/** Complete `depth` for every multipv line, then `bestmove`. */
function finish(t: FakeEngineTransport, multiPv: number, depth: number, pv = "e2e4 e7e5"): void {
	for (let d = 1; d <= depth; d++)
		for (let k = 1; k <= multiPv; k++) t.feed(infoLine(d, k, 30 - k, pv));
	t.feed(`bestmove ${pv.split(" ")[0]}`);
}

const setoptions = (lines: string[]): string[] => lines.filter((l) => l.startsWith("setoption"));

describe("EngineController options", () => {
	it("applies optionsForSettings on construction (Task 13 reference settings)", async () => {
		const { t, ctrl } = await setup();
		expect(setoptions(t.sent)).toEqual(REFERENCE_OPTION_LINES);
		expect(t.sent.at(-1)).toBe("isready");
		expect(ctrl.status().options).toEqual({
			Threads: 4,
			Hash: 32,
			MultiPV: 6,
			UCI_LimitStrength: true,
			UCI_Elo: 1500,
			UCI_ShowWDL: true,
			Ponder: false,
		});
		expect(ctrl.status().pendingOptions).toBe(false);
		expect(ctrl.engineElo()).toBe(1500);
	});
	it("sends only the diff on a settings change, nothing when unchanged", async () => {
		const { t, src, ctrl } = await setup();
		t.sent.length = 0;
		src.emit(settings({ targetElo: 1800 }));
		await flush();
		expect(t.sent).toEqual(["setoption name UCI_Elo value 1800", "isready"]);
		expect(ctrl.engineElo()).toBe(1800);
		t.sent.length = 0;
		src.emit(settings({ targetElo: 1800 }));
		await flush();
		expect(t.sent).toEqual([]);
		src.emit(settings({ targetElo: 800, engine: { hashMb: 64, threads: 2 } }));
		await flush();
		expect(t.sent).toEqual([
			"setoption name Threads value 2",
			"setoption name Hash value 64",
			"setoption name UCI_Elo value 1320",
			"isready",
		]);
	});
	it("uses the environment: no SharedArrayBuffer → one thread", async () => {
		const { t } = await setup({ deps: { env: { hardwareConcurrency: 8, sab: false } } });
		expect(setoptions(t.sent)[0]).toBe("setoption name Threads value 1");
	});
	it("defers a change while the engine is searching and applies it once idle", async () => {
		const { t, src, ctrl } = await setup();
		const h = ctrl.analyse(req({ id: "a", fen: START }));
		t.sent.length = 0;
		src.emit(settings({ targetElo: 2000 }));
		await flush();
		expect(t.sent).toEqual([]);
		expect(ctrl.status().pendingOptions).toBe(true);
		finish(t, 2, 3);
		await h.result;
		await flush();
		expect(t.sent).toEqual(["setoption name UCI_Elo value 2000", "isready"]);
		expect(ctrl.status().pendingOptions).toBe(false);
	});
	it("coalesces several deferred changes into one diff", async () => {
		const { t, src, ctrl } = await setup();
		const h = ctrl.analyse(req({ id: "a", fen: START }));
		t.sent.length = 0;
		src.emit(settings({ targetElo: 2000 }));
		src.emit(settings({ targetElo: 2100, engine: { hashMb: 64 } }));
		src.emit(settings({ targetElo: 1500, engine: { hashMb: 64 } }));
		await flush();
		finish(t, 2, 3);
		await h.result;
		await flush();
		expect(t.sent).toEqual(["setoption name Hash value 64", "isready"]);
	});
	it("holds the options until init() when constructed before the engine handshake", async () => {
		const { t, ctrl, eng } = await setup({ init: false });
		expect(setoptions(t.sent)).toEqual([]);
		expect(ctrl.status().pendingOptions).toBe(true);
		const info = await ctrl.init();
		await flush();
		expect(info.name).toBe("Fake 1");
		expect(eng.state()).toBe("idle");
		expect(setoptions(t.sent)).toEqual(REFERENCE_OPTION_LINES);
		expect(ctrl.status().pendingOptions).toBe(false);
	});
	it("dispose() unsubscribes from settings changes", async () => {
		const { t, src, ctrl } = await setup();
		expect(src.subscribers).toBe(1);
		ctrl.dispose();
		expect(src.subscribers).toBe(0);
		t.sent.length = 0;
		src.emit(settings({ targetElo: 2200 }));
		await flush();
		expect(t.sent).toEqual([]);
		ctrl.dispose();
		expect(src.subscribers).toBe(0);
	});
});

describe("EngineController analyse / cache", () => {
	it("serves a repeat request from the cache without touching the engine", async () => {
		const { t, ctrl, cache } = await setup();
		const first = ctrl.analyse(req({ id: "a", fen: START, limit: { movetimeMs: 500 } }));
		finish(t, 2, FEATURE_DEPTH + 2);
		const r1 = await first.result;
		expect(r1.status).toBe("complete");
		expect(cache.size).toBe(1);
		t.sent.length = 0;
		const second = ctrl.analyse(req({ id: "b", fen: START, limit: { movetimeMs: 500 } }));
		const r2 = await second.result;
		expect(t.sent).toEqual([]);
		expect(r2.id).toBe("b");
		expect(r2.request.id).toBe("b");
		expect(r2.bestmove).toBe("e2e4");
		expect(r2.status).toBe("complete");
		expect(r2.final.depth).toBe(FEATURE_DEPTH + 2);
		expect(r2.atFeatureDepth?.depth).toBe(FEATURE_DEPTH);
		const seen: number[] = [];
		for await (const u of second.updates) seen.push(u.depth);
		expect(seen).toEqual([FEATURE_DEPTH + 2]);
		await second.stop();
		expect(ctrl.status().inFlight).toBe(0);
	});
	it("misses the cache when the stored result is too shallow or a different strength", async () => {
		const { t, ctrl } = await setup();
		const first = ctrl.analyse(req({ id: "a", fen: START, limit: { movetimeMs: 500 } }));
		finish(t, 2, 4);
		await first.result;
		t.sent.length = 0;
		const second = ctrl.analyse(req({ id: "b", fen: START, limit: { movetimeMs: 500 } }));
		expect(t.sent.some((l) => l.startsWith("go "))).toBe(true);
		finish(t, 2, FEATURE_DEPTH);
		await second.result;
		t.sent.length = 0;
		const third = ctrl.analyse(req({ id: "c", fen: START, limit: { movetimeMs: 500 }, elo: 1500 }));
		expect(t.sent.some((l) => l.startsWith("go "))).toBe(true);
		finish(t, 2, FEATURE_DEPTH);
		await third.result;
	});
	it("keys a request with moves under the position they reach", async () => {
		const { t, ctrl, cache } = await setup();
		const first = ctrl.analyse(
			req({ id: "a", fen: START, moves: ["e2e4"], limit: { movetimeMs: 500 } })
		);
		expect(t.sent).toContain(`position fen ${START} moves e2e4`);
		finish(t, 2, FEATURE_DEPTH, "e7e5 g1f3");
		await first.result;
		expect(cache.get(AFTER_E4_NORMALISED, 2, FEATURE_DEPTH)).toBeDefined();
		t.sent.length = 0;
		const hit = ctrl.analyse(req({ id: "b", fen: AFTER_E4_NORMALISED, limit: { movetimeMs: 500 } }));
		const r = await hit.result;
		expect(t.sent).toEqual([]);
		expect(r.bestmove).toBe("e7e5");
	});
	it("does not use the cache for an infinite search below the depth cap", async () => {
		const { t, ctrl } = await setup();
		const first = ctrl.analyse(req({ id: "a", fen: START, limit: { movetimeMs: 500 } }));
		finish(t, 2, FEATURE_DEPTH);
		await first.result;
		t.sent.length = 0;
		const panel = ctrl.analyse(req({ id: "p", fen: START, priority: "panel" }));
		expect(t.sent.some((l) => l === "go infinite")).toBe(true);
		finish(t, 2, DEFAULT_SETTINGS.engine.depthCap);
		await panel.result;
		t.sent.length = 0;
		const again = ctrl.analyse(req({ id: "q", fen: START, priority: "panel" }));
		await again.result;
		expect(t.sent).toEqual([]);
	});
	it("works without a cache", async () => {
		const { t, ctrl } = await setup({ deps: { cache: undefined } });
		const first = ctrl.analyse(req({ id: "a", fen: START, limit: { movetimeMs: 500 } }));
		finish(t, 2, FEATURE_DEPTH);
		await first.result;
		t.sent.length = 0;
		ctrl.analyse(req({ id: "b", fen: START, limit: { movetimeMs: 500 } }));
		expect(t.sent.some((l) => l.startsWith("go "))).toBe(true);
		expect(ctrl.status().cacheSize).toBe(0);
	});
});

describe("EngineController priorities / ponder / newGame", () => {
	it("forwards priorities: ponder runs before panel, a move supersedes a ponder", async () => {
		const { t, ctrl } = await setup();
		const move = ctrl.analyse(req({ id: "m", fen: START, priority: "move" }));
		const panel = ctrl.analyse(req({ id: "p", fen: AFTER_D4, priority: "panel" }));
		const ponder = ctrl.ponder(AFTER_E4, [], 4);
		expect(ctrl.status().inFlight).toBe(3);
		t.sent.length = 0;
		finish(t, 2, 2);
		await move.result;
		expect(t.sent).toContain(`position fen ${AFTER_E4}`);
		expect(t.sent).toContain("setoption name MultiPV value 4");
		expect(t.sent.at(-1)).toBe("go infinite");
		expect(t.sent).not.toContain(`position fen ${AFTER_D4}`);
		t.sent.length = 0;
		const move2 = ctrl.analyse(req({ id: "m2", fen: START, priority: "move" }));
		expect(t.sent).toEqual(["stop"]);
		finish(t, 4, 1, "e7e5 g1f3");
		const pr = await ponder.result;
		expect(pr.status).toBe("superseded");
		expect(t.sent).toContain(`position fen ${START}`);
		finish(t, 2, 2);
		await move2.result;
		finish(t, 2, 2, "d7d5 c2c4");
		await panel.result;
		expect(ctrl.status().inFlight).toBe(0);
	});
	it("newGame(): once per game id, stops in-flight searches first, re-applies deferred options", async () => {
		const { t, src, ctrl } = await setup();
		const h: AnalysisHandle = ctrl.analyse(req({ id: "a", fen: START, priority: "ponder" }));
		src.emit(settings({ targetElo: 1700 }));
		await flush();
		t.sent.length = 0;
		const p = ctrl.newGame("g1");
		await flush();
		expect(t.sent).toEqual(["stop"]);
		t.feed("bestmove e2e4");
		await h.result;
		await p;
		await flush();
		expect(t.sent).toEqual([
			"stop",
			"ucinewgame",
			"isready",
			"setoption name UCI_Elo value 1700",
			"isready",
		]);
		expect(ctrl.status().gameId).toBe("g1");
		t.sent.length = 0;
		await ctrl.newGame("g1");
		expect(t.sent).toEqual([]);
		await ctrl.newGame("g2");
		expect(t.sent).toEqual(["ucinewgame", "isready"]);
		t.sent.length = 0;
		await ctrl.newGame();
		expect(t.sent).toEqual(["ucinewgame", "isready"]);
	});
	it("status() reports the engine state, cache size and last apply time", async () => {
		const { ctrl, sched } = await setup();
		const s = ctrl.status();
		expect(s.state).toBe("idle");
		expect(s.cacheSize).toBe(0);
		expect(s.optionsAppliedAt).toBe(sched.now);
		expect(s.gameId).toBeNull();
	});
});
