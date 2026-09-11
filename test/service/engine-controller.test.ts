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
	it("waits for a large network, replays options, and only then searches at unlimited strength", async () => {
		let release = (): void => {};
		const loading = new Promise<void>((resolve) => {
			release = resolve;
		});
		const variants: string[] = [];
		const { ctrl, t, eng } = await setup({
			settings: settings({ targetElo: 3650 }),
			deps: {
				configureVariant: async (variant) => {
					variants.push(variant);
					await loading;
				},
			},
		});
		expect(variants).toEqual(["full"]);
		expect(eng.state()).toBe("initialising");
		const move = ctrl.analyse(req({ id: "high", fen: START, elo: 1500 }));
		expect(t.sent.some((line) => line.startsWith("go "))).toBe(false);
		release();
		await flush();
		expect(t.sent).toContain("setoption name UCI_LimitStrength value false");
		expect(t.sent).not.toContain("setoption name UCI_Elo value 3650");
		expect(ctrl.engineElo()).toBeUndefined();
		expect(t.sent.indexOf("isready")).toBeLessThan(t.sent.indexOf("go infinite"));
		finish(t, 2, 12);
		expect((await move.result).request.elo).toBeUndefined();
		ctrl.dispose();
	});

	it("cancels a queued move immediately while the network is downloading", async () => {
		let release = (): void => {};
		const { ctrl, t } = await setup({
			settings: settings({ targetElo: 3650 }),
			deps: {
				configureVariant: () =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			},
		});
		const move = ctrl.analyse(req({ id: "cancel", fen: START }));
		await move.stop();
		expect((await move.result).status).toBe("superseded");
		release();
		await flush();
		expect(t.sent.some((line) => line.startsWith("go "))).toBe(false);
		ctrl.dispose();
	});

	it("newGame cancels queued old-game moves and waits for the network before resetting the engine", async () => {
		let release = (): void => {};
		const { ctrl, t } = await setup({
			init: false,
			settings: settings({ targetElo: 3650 }),
			deps: {
				configureVariant: () =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			},
		});
		const move = ctrl.analyse(req({ id: "old-game", fen: START }));
		expect(ctrl.status().inFlight).toBe(1);
		const reset = ctrl.newGame("next-game");
		expect((await move.result).status).toBe("superseded");
		expect(t.sent).not.toContain("ucinewgame");
		release();
		await reset;
		expect(ctrl.status().gameId).toBe("next-game");
		expect(t.sent).toContain("ucinewgame");
		expect(t.sent.some((line) => line.startsWith("go "))).toBe(false);
		ctrl.dispose();
	});

	it("crossing the network cutoff stops the current search and invalidates its cached evaluation", async () => {
		const variants: string[] = [];
		const { ctrl, src, t, cache } = await setup({
			deps: {
				configureVariant: async (variant) => {
					variants.push(variant);
				},
			},
		});
		await ctrl.init();
		const cached = ctrl.analyse(req({ id: "cached", fen: START, limit: { movetimeMs: 500 } }));
		finish(t, 2, FEATURE_DEPTH + 2);
		await cached.result;
		expect(cache.size).toBe(1);
		const active = ctrl.analyse(req({ id: "active", fen: AFTER_E4 }));
		src.emit(settings({ targetElo: 3650 }));
		expect(t.sent).toContain("stop");
		t.feed("bestmove e7e5");
		await active.result;
		await flush();
		expect(t.sent).toContain("stop");
		expect(variants).toEqual(["smallnet", "full"]);
		expect(cache.size).toBe(0);
		ctrl.dispose();
	});

	it("a ponder arriving immediately after game start waits for ucinewgame and readyok", async () => {
		const { ctrl, t } = await setup();
		t.sent.length = 0;
		const reset = ctrl.newGame("first-game");
		const ponder = ctrl.ponder(START, [], 2);
		await reset;
		await flush();
		expect(t.sent.indexOf("ucinewgame")).toBeGreaterThanOrEqual(0);
		expect(t.sent.indexOf("isready")).toBeLessThan(t.sent.indexOf("go infinite"));
		expect(ctrl.status().gameId).toBe("first-game");
		finish(t, 2, 2);
		await ponder.result;
		ctrl.dispose();
	});

	it("a failed full-network load fails the waiting move rather than using the small cache", async () => {
		const { ctrl, t } = await setup({
			settings: settings({ targetElo: 3650 }),
			deps: {
				configureVariant: async () => {
					throw new Error("checksum mismatch");
				},
			},
		});
		const move = ctrl.analyse(req({ id: "failed", fen: START }));
		expect((await move.result).status).toBe("failed");
		expect(t.sent.some((line) => line.startsWith("go "))).toBe(false);
		expect(ctrl.status().pendingOptions).toBe(true);
		ctrl.dispose();
	});

	it("a lower target cancels an in-flight upgrade and restores the requested small configuration", async () => {
		const variants: string[] = [];
		const { ctrl, src } = await setup({
			settings: settings({ targetElo: 3650 }),
			deps: {
				configureVariant: (variant, _threads, signal) => {
					variants.push(variant);
					if (variant === "smallnet") return Promise.resolve();
					return new Promise<void>((_resolve, reject) =>
						signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
					);
				},
			},
		});
		src.emit(settings({ targetElo: 1600 }));
		await flush();
		expect(variants).toEqual(["full", "smallnet"]);
		expect(ctrl.engineElo()).toBe(1600);
		expect(ctrl.status().pendingOptions).toBe(false);
		ctrl.dispose();
	});
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
	it("a repetition-aware search cannot reuse a FEN-only result with the same board and clock", async () => {
		const { t, ctrl } = await setup();
		const fen = START.replace("0 1", "4 3");
		const fresh = ctrl.analyse(req({ id: "fresh", fen, limit: { movetimeMs: 500 } }));
		finish(t, 2, FEATURE_DEPTH + 2);
		await fresh.result;
		t.sent.length = 0;
		const moves = ["g1f3", "g8f6", "f3g1", "f6g8"];
		const repeat = ctrl.analyse(req({ id: "repeat", fen: START, moves, limit: { movetimeMs: 500 } }));
		expect(t.sent).toContain(`position fen ${START} moves ${moves.join(" ")}`);
		finish(t, 2, FEATURE_DEPTH + 2);
		await repeat.result;
		t.sent.length = 0;
		await ctrl.analyse(req({ id: "same-repeat", fen: START, moves, limit: { movetimeMs: 500 } }))
			.result;
		expect(t.sent).toEqual([]);
	});
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
	it("a result keyed by a chess.js replay answers an own-move search spelled by the bridge", async () => {
		// The production handoff: the §7.4 premove policy analyses `m r` during the opponent's turn
		// and the controller keys it under `applyMoves(...)` — chess.js's spelling, with no
		// en-passant square. When the opponent plays that reply, the own-move search asks with
		// chess.com's own `getFEN()`, which *does* name the square. Keyed raw those are different
		// positions and the search ran again; the move could never come back instantly.
		const { t, ctrl } = await setup();
		const ponder = ctrl.analyse(
			req({ id: "p", fen: START, moves: ["e2e4"], multiPv: 3, limit: { movetimeMs: 500 } })
		);
		finish(t, 3, 14, "e7e5 g1f3");
		await ponder.result;
		t.sent.length = 0;

		// the own-move shape: `go movetime X depth <cap>`, the bridge's spelling of the same position
		const own = ctrl.analyse(
			req({ id: "o", fen: AFTER_E4, multiPv: 3, limit: { movetimeMs: 400, depth: 14 } })
		);
		// asserted before the await: a hit is a settled handle, a miss has already sent `position`/`go`
		expect(t.sent).toEqual([]);
		const r = await own.result;
		expect(r.bestmove).toBe("e7e5");
		expect(r.final.depth).toBe(14);
	});
	it("Appendix E §4.5: a hit within two plies of the requested depth cap skips the search", async () => {
		const { t, ctrl } = await setup();
		const first = ctrl.analyse(req({ id: "a", fen: START, multiPv: 2, limit: { movetimeMs: 500 } }));
		finish(t, 2, 12);
		await first.result;
		t.sent.length = 0;
		// depth 12 cached, cap 14 requested: inside the slack, no search
		const hit = ctrl.analyse(
			req({ id: "b", fen: START, multiPv: 2, limit: { movetimeMs: 400, depth: 14 } })
		);
		expect(t.sent).toEqual([]);
		await hit.result;
		// cap 18: outside the slack, the engine is asked
		const miss = ctrl.analyse(
			req({ id: "c", fen: START, multiPv: 2, limit: { movetimeMs: 400, depth: 18 } })
		);
		expect(t.sent.some((l) => l.startsWith("go "))).toBe(true);
		finish(t, 2, 18);
		await miss.result;
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
