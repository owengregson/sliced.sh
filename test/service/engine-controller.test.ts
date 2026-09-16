// test/service/engine-controller.test.ts
import { describe, expect, it } from "bun:test";
import { applyMoves, legalMoves, pvToSan } from "@core/chess/san";
import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { TIMINGS } from "@core/constants/timings";
import { AnalysisCache } from "@core/engine/analysis-cache";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import type { AnalysisHandle, AnalysisRequest } from "@core/engine/types";
import { FEATURE_DEPTH, UciEngine } from "@core/engine/uci-client";
import { EngineController, type EngineControllerDeps } from "@service/engine-controller";
import type { EngineVariant } from "@typedefs/engine";
import { DEFAULT_SETTINGS, type Settings } from "@typedefs/settings";
import { FakeEngineTransport, FakeScheduler, flush } from "../fakes/engine-transport";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const AFTER_D4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1";
/** chess.js omits an en-passant square no pawn can use; this is `applyMoves(START, ["e2e4"])`. */
const AFTER_E4_NORMALISED = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

const REFERENCE_OPTION_LINES = [
	"setoption name Threads value 8",
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
	const position =
		t.sent
			.filter((line) => line.startsWith("position fen "))
			.at(-1)
			?.slice(13) ?? START;
	const [start = START, moves] = position.split(" moves ");
	const fen = moves ? (applyMoves(start, moves.split(" ")) ?? start) : start;
	const roots = legalMoves(fen);
	const first = pv.split(" ")[0] ?? "";
	const variations = [pv, ...roots.filter((move) => move !== first)];
	for (let d = 1; d <= depth; d++)
		for (let k = 1; k <= multiPv; k++) t.feed(infoLine(d, k, 30 - k, variations[k - 1] ?? pv));
	t.feed(`bestmove ${pv.split(" ")[0]}`);
}

const setoptions = (lines: string[]): string[] => lines.filter((l) => l.startsWith("setoption"));

describe("EngineController active target routing", () => {
	it("a next-game Small request cancels the prior game's cold Full load before reset admission", async () => {
		const variants: string[] = [];
		const { ctrl, t } = await setup({
			deps: {
				configureVariant: (variant, _threads, signal) => {
					variants.push(variant);
					if (variant === "smallnet") return Promise.resolve();
					return new Promise<void>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				},
			},
		});
		await ctrl.init();
		const old = ctrl.analyse(req({ id: "previous-game", fen: START, targetElo: 3201 }));
		await flush();
		const reset = ctrl.newGame("new-small-game");
		// A Small target: the Maia cutoff (3200 was Small until 2026-09-15).
		const next = ctrl.analyse(req({ id: "next-game", fen: AFTER_E4, targetElo: MAIA.eloMax }));
		expect((await old.result).status).toBe("superseded");
		await reset;
		await flush();
		expect(variants).toEqual(["smallnet", "full", "smallnet"]);
		expect(t.sent.indexOf("ucinewgame")).toBeLessThan(t.sent.indexOf(`position fen ${AFTER_E4}`));
		expect(t.sent.filter((line) => line.startsWith("position fen "))).toEqual([
			`position fen ${AFTER_E4}`,
		]);
		finish(t, 2, 2, "e7e5");
		expect((await next.result).status).toBe("complete");
		ctrl.dispose();
	});
	it("the controller ponder API carries its matched target into network routing", async () => {
		const variants: string[] = [];
		const { ctrl, t } = await setup({
			deps: {
				configureVariant: async (variant) => {
					variants.push(variant);
				},
			},
		});
		await ctrl.init();
		const handle = ctrl.ponder(START, [], 2, 3201);
		await flush();
		expect(variants).toEqual(["smallnet", "full"]);
		finish(t, 2, 2);
		expect((await handle.result).request.targetElo).toBe(3201);
		ctrl.dispose();
	});
	it("invalidates Full cache on an acknowledged host fallback without repeatedly reloading Full", async () => {
		let loaded: EngineVariant = "full";
		const variants: string[] = [];
		const { ctrl, t, cache } = await setup({
			settings: settings({ targetElo: 3800 }),
			deps: {
				getLoadedVariant: () => loaded,
				configureVariant: async (variant) => {
					variants.push(variant);
				},
			},
		});
		await ctrl.init();
		const first = ctrl.analyse(
			req({ id: "before-fallback", fen: START, targetElo: 3201, limit: { movetimeMs: 500 } })
		);
		finish(t, 2, FEATURE_DEPTH + 2);
		await first.result;
		expect(cache.size).toBe(1);
		// RemoteEngine keeps fallbackFrom=full and accepts its ready Small worker.
		loaded = "smallnet";
		const next = ctrl.analyse(
			req({ id: "after-fallback", fen: START, targetElo: 3201, limit: { movetimeMs: 500 } })
		);
		expect(cache.size).toBe(0);
		expect(t.sent.filter((line) => line.startsWith("go "))).toHaveLength(2);
		finish(t, 2, FEATURE_DEPTH + 2);
		await next.result;
		expect(variants).toEqual(["full"]);
		expect(ctrl.status().pendingOptions).toBe(false);
		ctrl.dispose();
	});

	it("applies the latest non-network settings after a cold load, including with no waiting request", async () => {
		let release = (): void => {};
		const { ctrl, src } = await setup({
			deps: {
				configureVariant: () =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			},
		});
		src.emit(settings({ engine: { hashMb: 64, threads: 2 } }));
		release();
		await flush();
		expect(ctrl.status().pendingOptions).toBe(false);
		expect(ctrl.status().options?.Hash).toBe(64);
		expect(ctrl.status().options?.Threads).toBe(2);
		ctrl.dispose();
	});

	// Owner, 2026-09-15: the network switch is the Maia cutoff (it was 3190/3200 → Small, 3201 → Full).
	it("routes the Maia cutoff and just below it to Small and one above it to Full without limiting referee searches", async () => {
		const variants: string[] = [];
		const { ctrl, t, cache } = await setup({
			deps: {
				configureVariant: async (variant) => {
					variants.push(variant);
				},
			},
		});
		await ctrl.init();
		const below = MAIA.eloMax - 10;
		const cutoff = MAIA.eloMax;
		const above = MAIA.eloMax + 1;
		for (const targetElo of [below, cutoff, above, cutoff]) {
			const before = t.sent.filter((line) => line.startsWith("go ")).length;
			const handle = ctrl.analyse(
				req({ id: `target-${targetElo}-${before}`, fen: START, targetElo, limit: { movetimeMs: 500 } })
			);
			await flush();
			// The first two share a compatible full-strength Small evaluation.
			if (targetElo === cutoff && variants.length === 1) {
				expect(t.sent.filter((line) => line.startsWith("go ")).length).toBe(before);
			} else {
				expect(t.sent.filter((line) => line.startsWith("go ")).length).toBe(before + 1);
				finish(t, 2, FEATURE_DEPTH + 2);
			}
			expect((await handle.result).request.targetElo).toBe(targetElo);
			expect(t.sent.filter((line) => line.startsWith("setoption name UCI_LimitStrength")).at(-1)).toBe(
				"setoption name UCI_LimitStrength value false"
			);
			expect(variants.at(-1)).toBe(targetElo > MAIA.eloMax ? "full" : "smallnet");
			expect(cache.size).toBe(1);
		}
		expect(variants).toEqual(["smallnet", "full", "smallnet"]);
		ctrl.dispose();
	});

	it("public requests use stored settings after an explicit matched target, while Big stays explicit", async () => {
		const variants: string[] = [];
		const { ctrl, t, src } = await setup({
			settings: settings({ targetElo: 3800 }),
			deps: {
				configureVariant: async (variant) => {
					variants.push(variant);
				},
			},
		});
		await ctrl.init();
		// The Maia cutoff is the last Small target (2026-09-15; this was 3200, which is Full now).
		for (const targetElo of [MAIA.eloMax, undefined]) {
			const handle = ctrl.analyse(
				req({ id: `route-${targetElo}`, fen: START, ...(targetElo === undefined ? {} : { targetElo }) })
			);
			await flush();
			finish(t, 2, 2);
			await handle.result;
		}
		expect(variants).toEqual(["full", "smallnet", "full"]);
		src.emit(settings({ targetElo: 1500, engine: { nnue: "big" } }));
		await flush();
		const explicit = ctrl.analyse(
			// A target Auto would keep on Small (3190 was one before 2026-09-15), so Big is what decides.
			req({ id: "explicit-big", fen: START, targetElo: MAIA.eloMax, elo: 1700 })
		);
		await flush();
		finish(t, 2, 2);
		expect((await explicit.result).request.elo).toBe(1700);
		expect(variants).toEqual(["full", "smallnet", "full"]);
		expect(t.sent.filter((line) => line.startsWith("setoption name UCI_Elo")).at(-1)).toBe(
			"setoption name UCI_Elo value 1700"
		);
		ctrl.dispose();
	});

	it("keeps a canceled cold Full load warm for the next bounded request", async () => {
		let release = (): void => {};
		const variants: string[] = [];
		let fullSignal: AbortSignal | undefined;
		const { ctrl, t } = await setup({
			deps: {
				configureVariant: async (variant, _threads, signal) => {
					variants.push(variant);
					if (variant === "full") {
						fullSignal = signal;
						await new Promise<void>((resolve) => {
							release = resolve;
						});
					}
				},
			},
		});
		await ctrl.init();
		const first = ctrl.analyse(req({ id: "expires", fen: START, targetElo: 3201 }));
		await flush();
		await first.stop();
		expect((await first.result).status).toBe("superseded");
		expect(fullSignal?.aborted).toBe(false);
		const second = ctrl.analyse(req({ id: "retry", fen: START, targetElo: 3201 }));
		await flush();
		expect(variants).toEqual(["smallnet", "full"]);
		release();
		await flush();
		expect(t.sent.filter((line) => line.startsWith("go "))).toHaveLength(1);
		finish(t, 2, 2);
		expect((await second.result).status).toBe("complete");
		expect(ctrl.status().pendingOptions).toBe(false);
		ctrl.dispose();
	});

	it("a Small move preempts a cold Full panel load without dispatching the stale request", async () => {
		const variants: string[] = [];
		let fullSignal: AbortSignal | undefined;
		const { ctrl, t } = await setup({
			deps: {
				configureVariant: (variant, _threads, signal) => {
					variants.push(variant);
					if (variant === "smallnet") return Promise.resolve();
					fullSignal = signal;
					return new Promise<void>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				},
			},
		});
		await ctrl.init();
		const panel = ctrl.analyse(
			req({ id: "panel-load", fen: START, targetElo: 3201, priority: "panel" })
		);
		await flush();
		// A Small target: the Maia cutoff (3200 was Small until 2026-09-15).
		const move = ctrl.analyse(req({ id: "small-move", fen: AFTER_E4, targetElo: MAIA.eloMax }));
		expect((await panel.result).status).toBe("superseded");
		await flush();
		expect(fullSignal?.aborted).toBe(true);
		expect(variants).toEqual(["smallnet", "full", "smallnet"]);
		expect(t.sent.filter((line) => line.startsWith("position fen "))).toEqual([
			`position fen ${AFTER_E4}`,
		]);
		finish(t, 2, 2, "e7e5");
		expect((await move.result).status).toBe("complete");
		ctrl.dispose();
	});

	it("does not dispatch against a late successful response from an aborted network configuration", async () => {
		let release = (): void => {};
		const variants: string[] = [];
		const { ctrl, t } = await setup({
			deps: {
				configureVariant: async (variant) => {
					variants.push(variant);
					if (variant === "full")
						await new Promise<void>((resolve) => {
							release = resolve;
						});
				},
			},
		});
		await ctrl.init();
		const panel = ctrl.analyse(
			req({ id: "stale-full", fen: START, targetElo: 3201, priority: "panel" })
		);
		await flush();
		// A Small target: the Maia cutoff (3200 was Small until 2026-09-15).
		const move = ctrl.analyse(req({ id: "fresh-small", fen: AFTER_E4, targetElo: MAIA.eloMax }));
		expect((await panel.result).status).toBe("superseded");
		// A transport may finish a load just as cancellation arrives.
		release();
		await flush();
		expect(variants).toEqual(["smallnet", "full", "smallnet"]);
		expect(t.sent.filter((line) => line.startsWith("position fen "))).toEqual([
			`position fen ${AFTER_E4}`,
		]);
		finish(t, 2, 2, "e7e5");
		expect((await move.result).status).toBe("complete");
		ctrl.dispose();
	});

	it("queued cross-network panel work cannot preempt a move or jump ahead of newer move work", async () => {
		const variants: string[] = [];
		const { ctrl, t } = await setup({
			deps: {
				configureVariant: async (variant) => {
					variants.push(variant);
				},
			},
		});
		await ctrl.init();
		// Small through the Maia cutoff, Full above it (2026-09-15; these were 3200 / 3201 / 3190).
		const first = ctrl.analyse(req({ id: "first-move", fen: START, targetElo: MAIA.eloMax }));
		const panel = ctrl.analyse(
			req({ id: "full-panel", fen: AFTER_D4, targetElo: MAIA.eloMax + 1, priority: "panel" })
		);
		expect(t.sent).not.toContain("stop");
		expect(variants).toEqual(["smallnet"]);
		const next = ctrl.analyse(req({ id: "next-move", fen: AFTER_E4, targetElo: MAIA.eloMax - 10 }));
		expect(t.sent).toContain("stop");
		t.feed("bestmove e2e4");
		expect((await first.result).status).toBe("superseded");
		await flush();
		expect(variants).toEqual(["smallnet"]);
		expect(t.sent.filter((line) => line.startsWith("position fen ")).at(-1)).toBe(
			`position fen ${AFTER_E4}`
		);
		finish(t, 2, 2, "e7e5");
		await next.result;
		await flush();
		expect(variants).toEqual(["smallnet", "full"]);
		expect(t.sent.filter((line) => line.startsWith("position fen ")).at(-1)).toBe(
			`position fen ${AFTER_D4}`
		);
		finish(t, 2, 2, "d7d5");
		await panel.result;
		ctrl.dispose();
	});

	it("a settings change during matched search defers options without overriding its target", async () => {
		const variants: string[] = [];
		const { ctrl, t, src } = await setup({
			deps: {
				configureVariant: async (variant) => {
					variants.push(variant);
				},
			},
		});
		await ctrl.init();
		// A Small target: the Maia cutoff (3200 was Small until 2026-09-15).
		const active = ctrl.analyse(req({ id: "matched", fen: START, targetElo: MAIA.eloMax }));
		src.emit(settings({ targetElo: 3800, engine: { hashMb: 64 } }));
		expect(t.sent).not.toContain("stop");
		expect(ctrl.status().pendingOptions).toBe(true);
		finish(t, 2, 2);
		await active.result;
		await flush();
		expect(variants).toEqual(["smallnet"]);
		expect(ctrl.status().pendingOptions).toBe(false);
		expect(ctrl.status().options?.Hash).toBe(64);
		ctrl.dispose();
	});
});

describe("EngineController options", () => {
	it("waits for a large network and preserves the request's active rating through reconfiguration", async () => {
		let release = (): void => {};
		const loading = new Promise<void>((resolve) => {
			release = resolve;
		});
		const variants: string[] = [];
		const { ctrl, t, eng } = await setup({
			settings: settings({ targetElo: 3800 }),
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
		expect(t.sent).not.toContain("setoption name UCI_Elo value 3800");
		expect(ctrl.engineElo()).toBeUndefined();
		expect(t.sent).toContain("setoption name UCI_Elo value 1500");
		expect(t.sent.filter((line) => line.startsWith("setoption name UCI_LimitStrength")).at(-1)).toBe(
			"setoption name UCI_LimitStrength value true"
		);
		expect(t.sent.indexOf("isready")).toBeLessThan(t.sent.indexOf("go infinite"));
		finish(t, 2, 12);
		expect((await move.result).request.elo).toBe(1500);
		ctrl.dispose();
	});

	it("cancels a queued move immediately while the network is downloading", async () => {
		let release = (): void => {};
		const { ctrl, t } = await setup({
			settings: settings({ targetElo: 3800 }),
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
			settings: settings({ targetElo: 3800 }),
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
		src.emit(settings({ targetElo: 3800 }));
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
		expect(t.sent.indexOf("isready")).toBeLessThan(
			t.sent.indexOf(`go depth ${automaticDepthForElo(1500)} movetime ${TIMINGS.ponderMaxMs}`)
		);
		expect(ctrl.status().gameId).toBe("first-game");
		finish(t, 2, 2);
		await ponder.result;
		ctrl.dispose();
	});

	it("a failed full-network load fails the waiting move rather than using the small cache", async () => {
		const { ctrl, t } = await setup({
			settings: settings({ targetElo: 3800 }),
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
			settings: settings({ targetElo: 3800 }),
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
			Threads: 8,
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
	it("a `searchmoves` request neither reads from nor writes to the cache", async () => {
		const { t, ctrl, cache } = await setup();
		// a full analysis of the position is cached and would answer an unrestricted repeat…
		const full = ctrl.analyse(
			req({ id: "full", fen: START, multiPv: 3, limit: { movetimeMs: 500 } })
		);
		finish(t, 3, FEATURE_DEPTH + 2);
		await full.result;
		expect(cache.size).toBe(1);
		t.sent.length = 0;
		// …but not a restricted one: the engine is asked, with the restriction
		const restricted = ctrl.analyse(
			req({
				id: "restricted",
				fen: START,
				multiPv: 3,
				limit: { movetimeMs: 200 },
				searchmoves: ["b1c3", "a2a3", "h2h3"],
			})
		);
		expect(t.sent.some((l) => l.startsWith("go ") && l.includes("searchmoves b1c3 a2a3 h2h3"))).toBe(
			true
		);
		finish(t, 3, FEATURE_DEPTH + 2, "b1c3 e7e5");
		const r = await restricted.result;
		expect(r.status).toBe("complete");
		expect(r.request.id).toBe("restricted");
		// the restricted answer is not stored, and the full one is still the only entry
		expect(cache.size).toBe(1);
		expect(cache.get(START, 3, FEATURE_DEPTH)?.request.id).toBe("full");
		t.sent.length = 0;
		// the same restricted request again reaches the engine again
		const again = ctrl.analyse(
			req({
				id: "again",
				fen: START,
				multiPv: 3,
				limit: { movetimeMs: 200 },
				searchmoves: ["b1c3", "a2a3", "h2h3"],
			})
		);
		expect(t.sent.some((l) => l.startsWith("go "))).toBe(true);
		finish(t, 3, FEATURE_DEPTH + 2, "b1c3 e7e5");
		await again.result;
		expect(cache.size).toBe(1);
	});
	// H10 (2026-09-13): the Maia-shaped own-move search is the one restricted search that is cached
	// — on its root set — so the pre-analysis of the predicted position can answer the own move.
	it("a `shaped` searchmoves request is cached and answered on its root set; the unflagged one still is not", async () => {
		const { t, ctrl, cache } = await setup();
		const roots = ["b1c3", "d2d4", "e2e4"];
		/** A real engine reports only the restricted roots: complete `depth` over exactly them. */
		const finishRoots = (depth: number, over: readonly string[] = roots): void => {
			for (let d = 1; d <= depth; d++)
				for (let k = 1; k <= over.length; k++) t.feed(infoLine(d, k, 30 - k, over[k - 1] ?? ""));
			t.feed(`bestmove ${over[0]}`);
		};
		const shaped = ctrl.analyse(
			req({
				id: "shaped",
				fen: START,
				multiPv: 3,
				limit: { movetimeMs: 500 },
				searchmoves: roots,
				shaped: true,
			})
		);
		expect(t.sent.some((l) => l.startsWith("go ") && l.endsWith("searchmoves b1c3 d2d4 e2e4"))).toBe(
			true
		);
		finishRoots(FEATURE_DEPTH + 2);
		const r1 = await shaped.result;
		expect(r1.status).toBe("complete");
		expect(cache.size).toBe(1);
		t.sent.length = 0;
		// the same roots in another order: a settled handle, nothing on the wire
		const hit = ctrl.analyse(
			req({
				id: "hit",
				fen: START,
				multiPv: 3,
				limit: { movetimeMs: 500 },
				searchmoves: ["e2e4", "b1c3", "d2d4"],
				shaped: true,
			})
		);
		const r2 = await hit.result;
		expect(t.sent).toEqual([]);
		expect(r2.id).toBe("hit");
		expect(r2.bestmove).toBe("b1c3");
		expect(r2.final.lines.map((l) => l.pvUci[0])).toEqual(roots);
		// another root set (stored under its own roots), an unrestricted request (stored) and the
		// unflagged restriction (never stored) all reach the engine
		t.sent.length = 0;
		const subset = ctrl.analyse(
			req({
				id: "subset",
				fen: START,
				multiPv: 2,
				limit: { movetimeMs: 500 },
				searchmoves: ["b1c3", "d2d4"],
				shaped: true,
			})
		);
		expect(t.sent.some((l) => l.startsWith("go ") && l.endsWith("searchmoves b1c3 d2d4"))).toBe(true);
		finishRoots(FEATURE_DEPTH + 2, ["b1c3", "d2d4"]);
		await subset.result;
		expect(cache.size).toBe(2);
		t.sent.length = 0;
		const open = ctrl.analyse(
			req({ id: "open", fen: START, multiPv: 3, limit: { movetimeMs: 500 } })
		);
		expect(t.sent.some((l) => l.startsWith("go ") && !l.includes("searchmoves"))).toBe(true);
		finish(t, 3, FEATURE_DEPTH + 2);
		await open.result;
		expect(cache.size).toBe(3);
		t.sent.length = 0;
		const unflagged = ctrl.analyse(
			req({ id: "unflagged", fen: START, multiPv: 3, limit: { movetimeMs: 500 }, searchmoves: roots })
		);
		expect(t.sent.some((l) => l.startsWith("go ") && l.endsWith("searchmoves b1c3 d2d4 e2e4"))).toBe(
			true
		);
		finishRoots(FEATURE_DEPTH + 2);
		await unflagged.result;
		expect(cache.size).toBe(3);
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
	it("H4: a request for a human frame misses a result captured at the default one, and hits its own", async () => {
		const { t, ctrl } = await setup();
		const plain = ctrl.analyse(
			req({ id: "plain", fen: START, multiPv: 2, limit: { movetimeMs: 500, depth: 14 } })
		);
		finish(t, 2, 14);
		await plain.result;
		t.sent.length = 0;
		// the same shape with `featureDepth: 4` is a different identity: the engine is asked
		const human = ctrl.analyse(
			req({
				id: "human",
				fen: START,
				multiPv: 2,
				limit: { movetimeMs: 500, depth: 14 },
				featureDepth: 4,
			})
		);
		expect(t.sent.some((l) => l.startsWith("go "))).toBe(true);
		finish(t, 2, 14);
		const r = await human.result;
		expect(r.atFeatureDepth?.depth).toBe(4);
		t.sent.length = 0;
		// …and answers the next identical request, frame included
		const again = ctrl.analyse(
			req({
				id: "again",
				fen: START,
				multiPv: 2,
				limit: { movetimeMs: 500, depth: 14 },
				featureDepth: 4,
			})
		);
		expect(t.sent).toEqual([]);
		expect((await again.result).atFeatureDepth?.depth).toBe(4);
		// while the plain shape still hits the plain result with the default frame
		const plainAgain = ctrl.analyse(
			req({ id: "plain-again", fen: START, multiPv: 2, limit: { movetimeMs: 500, depth: 14 } })
		);
		expect(t.sent).toEqual([]);
		expect((await plainAgain.result).atFeatureDepth?.depth).toBe(FEATURE_DEPTH);
	});
	it("does not use the cache for an infinite search below the depth cap", async () => {
		const { t, ctrl } = await setup();
		const first = ctrl.analyse(req({ id: "a", fen: START, limit: { movetimeMs: 500 } }));
		finish(t, 2, FEATURE_DEPTH);
		await first.result;
		t.sent.length = 0;
		const panel = ctrl.analyse(req({ id: "p", fen: START, priority: "panel" }));
		expect(t.sent.some((l) => l === "go infinite")).toBe(true);
		finish(t, 2, LIMITS.depthMax);
		await panel.result;
		t.sent.length = 0;
		const again = ctrl.analyse(req({ id: "q", fen: START, priority: "panel" }));
		await again.result;
		expect(t.sent).toEqual([]);
	});
	it("honors low explicit caps below feature depth and rejects deeper cached analysis", async () => {
		const { t, ctrl } = await setup();
		const deep = ctrl.analyse(req({ id: "deep", fen: START, limit: { movetimeMs: 500 } }));
		finish(t, 2, 20);
		await deep.result;
		t.sent.length = 0;
		const shallow = ctrl.analyse(
			req({ id: "shallow", fen: START, limit: { depth: 6, movetimeMs: 400 } })
		);
		expect(t.sent).toContain("go depth 6 movetime 400");
		finish(t, 2, 6);
		await shallow.result;
		t.sent.length = 0;
		const reused = ctrl.analyse(
			req({ id: "reuse", fen: START, limit: { depth: 6, movetimeMs: 400 } })
		);
		expect((await reused.result).final.depth).toBe(6);
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
	it("caps convenience pondering by its active target instead of saved Elo or manual depth", async () => {
		const { t, ctrl } = await setup({
			settings: settings({ targetElo: 1500, engine: { depthCap: 6 } }),
		});
		const p = ctrl.ponder(START, [], 2, 3300);
		expect(t.sent).toContain(`go depth 30 movetime ${TIMINGS.ponderMaxMs}`);
		expect(t.sent).not.toContain("go infinite");
		finish(t, 2, 30);
		const result = await p.result;
		expect(result.request.limit).toEqual({ depth: 30, movetimeMs: TIMINGS.ponderMaxMs });
		expect(result.request.elo).toBeUndefined();
	});

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
		expect(t.sent.at(-1)).toBe(
			`go depth ${automaticDepthForElo(1500)} movetime ${TIMINGS.ponderMaxMs}`
		);
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
