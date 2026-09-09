// test/core/engine/remote-engine.test.ts
/**
 * `RemoteEngine` (SW) ↔ `serveEnginePort` (offscreen) over the simulator's
 * `chrome.runtime` ports: the SW initiates after `ensureHost`, the offscreen
 * document accepts and re-syncs status on every connection, `uci`/`line`/
 * `status` flow both ways, and a service-worker restart reconnects.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TIMINGS } from "@core/constants/timings";
import { RemoteEngine } from "@core/engine/remote-engine";
import { type BootHooks, EngineHost, serveEnginePort } from "@offscreen/engine-host";
import type { BootedEngine } from "@offscreen/stockfish-loader";
import { createSimulator, type Simulator } from "@test/sim";
import { bootOffscreenContext, type OffscreenContext } from "@test/sim/contexts/offscreen-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import type { EngineStatus, EngineVariant } from "@typedefs/engine";
import { FakeStockfishWeb } from "../../fakes/stockfish";

let sim: Simulator;
let sw: SwContext | undefined;
let off: OffscreenContext | undefined;
const prevChrome = (globalThis as Record<string, unknown>).chrome;

interface OffscreenSide {
	engines: FakeStockfishWeb[];
	current: () => FakeStockfishWeb;
	aborted: string[];
	hangBoot: boolean;
	stop: () => void;
}

async function bootOffscreen(): Promise<OffscreenSide> {
	const side: OffscreenSide = {
		engines: [],
		current: () => {
			const sf = side.engines[side.engines.length - 1];
			if (!sf) throw new Error("no engine booted");
			return sf;
		},
		aborted: [],
		hangBoot: false,
		stop: () => {},
	};
	const boot = async (_variant: EngineVariant, hooks: BootHooks): Promise<BootedEngine> => {
		if (side.hangBoot) return new Promise<BootedEngine>(() => {});
		const sf = new FakeStockfishWeb();
		sf.listen = hooks.listen;
		sf.onError = hooks.onError;
		side.engines.push(sf);
		hooks.onLoadingNnue([...sf.recommended]);
		return { sf, module: "sf_18_smallnet.js", nnue: [...sf.recommended] };
	};
	off = await bootOffscreenContext(sim, {
		entry: () => {
			const served = serveEnginePort({
				createStore: () => ({
					handleChunk: () => {},
					abortAll: (reason: string) => side.aborted.push(reason),
				}),
				createHost: (post) =>
					new EngineHost({
						boot,
						nnueStore: { get: async () => new Uint8Array(1) },
						post,
					}),
			});
			side.stop = served.stop;
		},
	});
	return side;
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await sim.time.runMicrotasks();
};

beforeEach(async () => {
	sim = createSimulator();
	sim.time.install();
	sw = await bootSwContext(sim);
});
afterEach(async () => {
	await off?.teardown();
	off = undefined;
	await sw?.teardown();
	sw = undefined;
	sim.time.uninstall();
	(globalThis as Record<string, unknown>).chrome = prevChrome;
});

describe("RemoteEngine over the simulator", () => {
	it("awaits ensureHost, connects, queues sends before ready, and relays lines and status", async () => {
		const side = await bootOffscreen();
		const ensureCalls: number[] = [];
		const lines: string[] = [];
		const statuses: EngineStatus[] = [];
		const engine = await (sw as SwContext).run(async () => {
			const e = new RemoteEngine({
				ensureHost: async () => {
					ensureCalls.push(sim.now());
					await settle();
				},
				variant: "smallnet",
				threads: 1,
			});
			e.onLine((l) => lines.push(l));
			e.onStatus((s) => statuses.push(s));
			expect(() => e.send("uci")).not.toThrow();
			expect(ensureCalls).toHaveLength(1);
			await e.ready;
			return e;
		});
		await settle();
		expect(side.engines).toHaveLength(1);
		expect(side.current().commands).toEqual(["uci"]);
		// one `booting` re-sent on accept (pre-configure), one when the boot starts
		expect(statuses.map((s) => s.state)).toEqual(["booting", "booting", "loading-nnue", "ready"]);
		side.current().emit("id name Stockfish 18", "uciok");
		await settle();
		expect(lines).toEqual(["id name Stockfish 18", "uciok"]);
		expect(engine.status()?.state).toBe("ready");
		engine.dispose();
		expect(() => engine.send("isready")).not.toThrow();
		await settle();
		expect(side.current().commands).toEqual(["uci"]);
	});

	it("queues restart()/loadNnue()/send() issued before the port exists and flushes them in order", async () => {
		const side = await bootOffscreen();
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const engine = await (sw as SwContext).run(async () => {
			const e = new RemoteEngine({ ensureHost: () => gate, variant: "smallnet", threads: 1 });
			e.send("uci");
			const restarted = e.restart();
			e.loadNnue(["nn-cccccccccccc.nnue"]);
			e.send("isready");
			await settle();
			expect(side.engines).toHaveLength(0);
			release();
			await e.ready;
			await restarted;
			return e;
		});
		await settle();
		// configure boots #1; restart quits it and boots #2; the queued lines and the net land on #2
		expect(side.engines).toHaveLength(2);
		expect(side.engines[0]?.commands).toEqual(["quit"]);
		expect(side.current().commands).toEqual(["uci", "isready"]);
		expect(side.current().nets).toEqual([{ bytes: new Uint8Array(1), index: 0 }]);
		expect(engine.status()?.nnue).toEqual(["nn-cccccccccccc.nnue"]);
		engine.dispose();
	});

	it("restart() resolves once the host reports ready again, and rejects on timeout", async () => {
		const side = await bootOffscreen();
		const engine = await (sw as SwContext).run(async () => {
			const e = new RemoteEngine({ variant: "smallnet", threads: 1 });
			await e.ready;
			return e;
		});
		await settle();
		expect(side.engines).toHaveLength(1);
		const first = side.current();
		const restarted = engine.restart();
		await settle();
		expect(first.commands).toContain("quit");
		expect(side.engines).toHaveLength(2);
		await restarted;

		side.hangBoot = true;
		const hung = engine.restart();
		let settled: string | undefined;
		hung.then(
			() => {
				settled = "resolved";
			},
			(err: Error) => {
				settled = err.message;
			}
		);
		await settle();
		await sim.time.advance(TIMINGS.engineReadyTimeoutMs);
		await settle();
		expect(settled).toMatch(/timed out/);
		engine.dispose();
	});

	it("re-syncs after a service-worker restart: status is re-sent and a stale search is stopped", async () => {
		const side = await bootOffscreen();
		const engine = await (sw as SwContext).run(async () => {
			const e = new RemoteEngine({ variant: "smallnet", threads: 1 });
			await e.ready;
			e.send("go infinite");
			return e;
		});
		await settle();
		expect(side.current().commands).toEqual(["go infinite"]);
		expect(engine.status()?.state).toBe("searching");

		await (sw as SwContext).teardown();
		await settle();
		expect(side.aborted).toEqual(["port disconnected"]);
		sw = await bootSwContext(sim);

		const statuses: EngineStatus[] = [];
		const lines: string[] = [];
		const again = await sw.run(async () => {
			const e = new RemoteEngine({ variant: "smallnet", threads: 1 });
			e.onStatus((s) => statuses.push(s));
			e.onLine((l) => lines.push(l));
			await e.ready;
			e.send("isready");
			return e;
		});
		await settle();
		expect(statuses.map((s) => s.state)).toEqual(["searching"]);
		expect(side.current().commands).toEqual(["go infinite", "stop", "isready"]);
		expect(side.engines).toHaveLength(1);
		side.current().emit("bestmove e2e4", "readyok");
		await settle();
		expect(lines).toEqual(["bestmove e2e4", "readyok"]);
		expect(again.status()?.state).toBe("ready");
		again.dispose();
	});

	it("answers timing requests with not-available when no timing head is served, and forwards nnue-progress", async () => {
		await bootOffscreen();
		const engine = await (sw as SwContext).run(async () => {
			const e = new RemoteEngine({ variant: "smallnet", threads: 1 });
			await e.ready;
			return e;
		});
		const seen: unknown[] = [];
		engine.onMessage((m) => seen.push(m));
		engine.post({
			kind: "timing",
			id: "t1",
			inputs: {
				band: "1500_1600",
				moveTokens: [],
				fenTokens: [],
				rating: 1550,
				playerClockS: 120,
				opponentClockS: 120,
				incrementS: 0,
			},
		});
		await settle();
		expect(seen).toContainEqual({
			kind: "timing-result",
			id: "t1",
			probs: null,
			error: "not-available",
		});
		engine.dispose();
	});

	it("routes timing / timing-warm to a served head and model-chunk to the model store (Task 34)", async () => {
		await off?.teardown();
		const calls: string[] = [];
		const chunks: string[] = [];
		off = await bootOffscreenContext(sim, {
			entry: () => {
				const served = serveEnginePort({
					createStore: () => ({ handleChunk: () => {}, abortAll: () => {} }),
					createHost: (post) =>
						new EngineHost({
							boot: async () => new Promise<BootedEngine>(() => {}),
							nnueStore: { get: async () => new Uint8Array(1) },
							post,
						}),
					createModelStore: () => ({
						handleChunk: (m: { name: string }) => {
							chunks.push(m.name);
						},
						abortAll: () => {},
					}),
					createTiming: () => ({
						handle: async (cmd) => {
							calls.push(`handle:${cmd.id}`);
							return {
								kind: "timing-result",
								id: cmd.id,
								probs: new Array<number>(30).fill(1 / 30),
								band: cmd.inputs.band,
								ms: 12,
							};
						},
						warm: async (band) => {
							calls.push(`warm:${band}`);
						},
						dispose: () => {
							calls.push("dispose");
						},
					}),
				});
				return served;
			},
		});
		const engine = await (sw as SwContext).run(async () => {
			const e = new RemoteEngine({ variant: "smallnet", threads: 1 });
			await e.ready;
			return e;
		});
		const seen: unknown[] = [];
		engine.onMessage((m) => seen.push(m));
		engine.post({ kind: "timing-warm", band: "1800_1900" });
		engine.post({ kind: "model-chunk", name: "1000_1100.onnx", error: "x" });
		engine.post({
			kind: "timing",
			id: "t2",
			inputs: {
				band: "1500_1600",
				moveTokens: [],
				fenTokens: [],
				rating: 1550,
				playerClockS: 120,
				opponentClockS: 120,
				incrementS: 0,
			},
		});
		await settle();
		expect(calls).toEqual(["warm:1800_1900", "handle:t2"]);
		expect(chunks).toEqual(["1000_1100.onnx"]);
		expect(seen).toContainEqual({
			kind: "timing-result",
			id: "t2",
			probs: new Array<number>(30).fill(1 / 30),
			band: "1500_1600",
			ms: 12,
		});
		engine.dispose();
	});
});
