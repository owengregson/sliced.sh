// test/offscreen/engine-host.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MAIA } from "@core/constants/maia";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { RemoteEngine } from "@core/engine/remote-engine";
import { type BootHooks, EngineHost, serveEnginePort } from "@offscreen/engine-host";
import { POLICY_NOT_AVAILABLE } from "@offscreen/policy-inference";
import type { BootedEngine } from "@offscreen/stockfish-loader";
import { createSimulator, type Simulator } from "@test/sim";
import { bootOffscreenContext, type OffscreenContext } from "@test/sim/contexts/offscreen-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import type { EngineVariant } from "@typedefs/engine";
import { FakeScheduler, flush } from "../fakes/engine-transport";
import { FakeStockfishWeb } from "../fakes/stockfish";

const NETS = ["nn-aaaaaaaaaaaa.nnue", "nn-bbbbbbbbbbbb.nnue"];

function bytesFor(name: string): Uint8Array {
	return new TextEncoder().encode(name);
}

interface Harness {
	host: EngineHost;
	posted: EnginePortMessage[];
	states: () => string[];
	lines: () => string[];
	boots: FakeStockfishWeb[];
	bootCalls: EngineVariant[];
	sched: FakeScheduler;
	gets: string[];
	/** Names passed to `nnueStore.delete`. */
	deleted: string[];
	/** Names the store rejects with `store failed: <name>`. */
	failGets: Set<string>;
	/** Make the next boot reject with `message` (once). */
	failNextBoot: (message: string) => void;
	/** Make the next boot hang forever (once). */
	hangNextBoot: () => void;
}

function setup(recommended: readonly string[] = NETS): Harness {
	const posted: EnginePortMessage[] = [];
	const boots: FakeStockfishWeb[] = [];
	const bootCalls: EngineVariant[] = [];
	const gets: string[] = [];
	const failGets = new Set<string>();
	const deleted: string[] = [];
	const sched = new FakeScheduler();
	let failWith: string | undefined;
	let hang = false;
	const nnueStore = {
		get: async (name: string): Promise<Uint8Array> => {
			gets.push(name);
			if (failGets.has(name)) throw new Error(`store failed: ${name}`);
			return bytesFor(name);
		},
		delete: async (name: string): Promise<void> => {
			deleted.push(name);
		},
	};
	const boot = async (variant: EngineVariant, hooks: BootHooks): Promise<BootedEngine> => {
		bootCalls.push(variant);
		if (hang) {
			hang = false;
			return new Promise<BootedEngine>(() => {});
		}
		if (failWith !== undefined) {
			const message = failWith;
			failWith = undefined;
			throw new Error(message);
		}
		const sf = new FakeStockfishWeb(recommended);
		sf.listen = hooks.listen;
		sf.onError = hooks.onError;
		boots.push(sf);
		hooks.onLoadingNnue([...recommended]);
		for (let i = 0; i < recommended.length; i++) {
			const name = recommended[i] as string;
			sf.setNnueBuffer(await nnueStore.get(name), i);
		}
		return { sf, module: "sf_19_smallnet.js", nnue: [...recommended] };
	};
	const host = new EngineHost({
		boot,
		nnueStore,
		post: (m) => posted.push(m),
		scheduler: sched.scheduler,
	});
	return {
		host,
		posted,
		boots,
		bootCalls,
		sched,
		gets,
		deleted,
		failGets,
		states: () => posted.flatMap((m) => (m.kind === "status" ? [m.status.state] : [])) as string[],
		lines: () => posted.flatMap((m) => (m.kind === "line" ? [m.line] : [])),
		failNextBoot: (message) => {
			failWith = message;
		},
		hangNextBoot: () => {
			hang = true;
		},
	};
}

async function booted(h: Harness): Promise<FakeStockfishWeb> {
	h.host.handle({ kind: "configure", variant: "smallnet", threads: 2 });
	await flush();
	const sf = h.boots[h.boots.length - 1];
	if (!sf) throw new Error("engine did not boot");
	return sf;
}

describe("EngineHost boot and status", () => {
	it("boots on configure with booting → loading-nnue → ready and reports the nets", async () => {
		const h = setup();
		expect(h.host.status().state).toBe("booting");
		const sf = await booted(h);
		expect(h.bootCalls).toEqual(["smallnet"]);
		expect(h.states()).toEqual(["booting", "loading-nnue", "ready"]);
		expect(sf.nets.map((n) => n.index)).toEqual([0, 1]);
		const status = h.host.status();
		expect(status).toMatchObject({
			state: "ready",
			variant: "smallnet",
			threads: 2,
			nnue: NETS,
			version: "sf_19_smallnet.js",
		});
		expect(status.error).toBeUndefined();
	});

	it("forwards uci commands to sf.uci and engine output to the port as lines", async () => {
		const h = setup();
		const sf = await booted(h);
		h.host.handle({ kind: "uci", line: "uci" });
		expect(sf.commands).toEqual(["uci"]);
		sf.emit("id name Stockfish 19", "uciok");
		expect(h.lines()).toEqual(["id name Stockfish 19", "uciok"]);
		expect(h.host.status().version).toBe("Stockfish 19");
	});

	it("queues uci lines that arrive before the engine is ready (booting on demand)", async () => {
		const h = setup();
		h.host.handle({ kind: "uci", line: "uci" });
		h.host.handle({ kind: "uci", line: "isready" });
		expect(h.bootCalls).toEqual(["smallnet"]);
		await flush();
		expect(h.boots[0]?.commands).toEqual(["uci", "isready"]);
	});

	it("tracks searching on go and ready on bestmove, with nps from the last info", async () => {
		const h = setup();
		const sf = await booted(h);
		h.host.handle({ kind: "uci", line: "go depth 8" });
		expect(h.host.status().state).toBe("searching");
		sf.emit("info depth 8 multipv 1 score cp 10 nodes 10 nps 4242 time 3 pv e2e4");
		sf.emit("bestmove e2e4");
		expect(h.host.status().state).toBe("ready");
		expect(h.host.status().nps).toBe(4242);
		expect(h.states().slice(-2)).toEqual(["searching", "ready"]);
	});

	it("re-configuring with the same variant only updates threads; a new variant reboots", async () => {
		const h = setup();
		const first = await booted(h);
		h.host.handle({ kind: "configure", variant: "smallnet", threads: 4 });
		await flush();
		expect(h.bootCalls).toEqual(["smallnet"]);
		expect(h.host.status().threads).toBe(4);
		h.host.handle({ kind: "configure", variant: "full", threads: 4 });
		await flush();
		expect(h.bootCalls).toEqual(["smallnet", "full"]);
		expect(first.commands).toContain("quit");
		expect(h.host.status().variant).toBe("full");
	});
});

describe("EngineHost info backpressure (§6.4)", () => {
	it("coalesces info lines per multipv and forwards at most every engineInfoForwardMs", async () => {
		const h = setup();
		const sf = await booted(h);
		const d = (mpv: number, cp: number) => `info depth 5 multipv ${mpv} score cp ${cp} pv e2e4`;
		sf.emit(d(1, 10), d(2, 5), d(1, 12), "info depth 5 currmove d2d4 currmovenumber 2", d(2, 7));
		expect(h.lines()).toEqual([]);
		h.sched.advance(0); // first forward is immediate (nothing was forwarded recently)
		expect(h.lines()).toEqual([d(1, 12), d(2, 7)]);
		sf.emit(d(1, 13));
		h.sched.advance(TIMINGS.engineInfoForwardMs - 1);
		expect(h.lines()).toHaveLength(2);
		h.sched.advance(1);
		expect(h.lines()).toEqual([d(1, 12), d(2, 7), d(1, 13)]);
		h.sched.advance(TIMINGS.engineInfoForwardMs);
		sf.emit(d(2, 8));
		h.sched.advance(0); // the interval has elapsed: forwarded at once
		expect(h.lines()).toHaveLength(4);
	});

	it("flushes pending info before a non-info line so order is preserved", async () => {
		const h = setup();
		const sf = await booted(h);
		const info = "info depth 9 multipv 1 score cp 1 pv e2e4";
		sf.emit(info, "bestmove e2e4");
		expect(h.lines()).toEqual([info, "bestmove e2e4"]);
		expect(h.sched.pending).toBe(0);
		sf.emit("info string NNUE evaluation using nn-x.nnue");
		expect(h.lines()).toHaveLength(3);
	});
});

describe("EngineHost loadNnue and restart", () => {
	it("loadNnue sets each named net in order and reports loading-nnue → ready", async () => {
		const h = setup();
		const sf = await booted(h);
		h.gets.length = 0;
		sf.nets.length = 0;
		h.host.handle({ kind: "loadNnue", names: ["nn-cccccccccccc.nnue", "nn-dddddddddddd.nnue"] });
		await flush();
		expect(h.gets).toEqual(["nn-cccccccccccc.nnue", "nn-dddddddddddd.nnue"]);
		expect(sf.nets).toEqual([
			{ bytes: bytesFor("nn-cccccccccccc.nnue"), index: 0 },
			{ bytes: bytesFor("nn-dddddddddddd.nnue"), index: 1 },
		]);
		expect(h.states().slice(-2)).toEqual(["loading-nnue", "ready"]);
		expect(h.host.status().nnue).toEqual(["nn-cccccccccccc.nnue", "nn-dddddddddddd.nnue"]);
	});

	it("a failed loadNnue keeps the engine ready and carries the error until the next transition", async () => {
		const h = setup();
		const sf = await booted(h);
		h.failGets.add("nn-eeeeeeeeeeee.nnue");
		h.host.handle({ kind: "loadNnue", names: ["nn-eeeeeeeeeeee.nnue"] });
		await flush();
		expect(sf.nets).toHaveLength(NETS.length);
		expect(h.host.status()).toMatchObject({
			state: "ready",
			nnue: NETS,
			error: "store failed: nn-eeeeeeeeeeee.nnue",
		});
		h.host.handle({ kind: "uci", line: "go depth 1" });
		expect(h.host.status().error).toBeUndefined();
	});

	it("restart quits the running engine and boots a fresh one", async () => {
		const h = setup();
		const first = await booted(h);
		h.host.handle({ kind: "restart" });
		await flush();
		expect(first.commands).toContain("quit");
		expect(h.bootCalls).toEqual(["smallnet", "smallnet"]);
		expect(h.boots).toHaveLength(2);
		expect(h.host.status().state).toBe("ready");
		// output from the old instance is ignored
		first.emit("bestmove e2e4");
		expect(h.lines()).toEqual([]);
	});
});

describe("EngineHost crash recovery", () => {
	it("onError reports crashed with the message then reboots after the backoff", async () => {
		const h = setup();
		const sf = await booted(h);
		sf.fail("Aborted(native code called abort())");
		const crashed = h.posted[h.posted.length - 1];
		expect(crashed).toMatchObject({
			kind: "status",
			status: { state: "crashed", error: "Aborted(native code called abort())" },
		});
		expect(h.bootCalls).toHaveLength(1);
		h.sched.advance(TIMINGS.engineRestartBackoffMs[0] - 1);
		expect(h.bootCalls).toHaveLength(1);
		h.sched.advance(1);
		expect(h.bootCalls).toHaveLength(2);
		await flush();
		expect(h.host.status().state).toBe("ready");
		expect(h.host.status().error).toBeUndefined();
	});

	it("gives up after the last backoff step and stays crashed with the error", async () => {
		const h = setup();
		let sf = await booted(h);
		const steps = TIMINGS.engineRestartBackoffMs;
		for (let i = 0; i < steps.length; i++) {
			sf.fail(`crash ${i}`);
			h.sched.advance(steps[i] as number);
			await flush();
			sf = h.boots[h.boots.length - 1] as FakeStockfishWeb;
			expect(h.bootCalls).toHaveLength(i + 2);
		}
		sf.fail("crash final");
		h.sched.advance(steps[steps.length - 1] as number);
		await flush();
		expect(h.bootCalls).toHaveLength(steps.length + 1);
		expect(h.host.status()).toMatchObject({ state: "crashed", error: "crash final" });
		expect(h.sched.pending).toBe(0);
	});

	it("after giving up, the next uci line (the SW re-initialising) triggers a fresh boot", async () => {
		const h = setup();
		let sf = await booted(h);
		const steps = TIMINGS.engineRestartBackoffMs;
		for (let i = 0; i <= steps.length; i++) {
			sf.fail(`crash ${i}`);
			h.sched.advance(steps[Math.min(i, steps.length - 1)] as number);
			await flush();
			sf = h.boots[h.boots.length - 1] as FakeStockfishWeb;
		}
		expect(h.host.status().state).toBe("crashed");
		const boots = h.bootCalls.length;
		h.host.handle({ kind: "uci", line: "uci" });
		expect(h.bootCalls).toHaveLength(boots + 1);
		await flush();
		expect(h.host.status().state).toBe("ready");
		expect(h.boots[h.boots.length - 1]?.commands).toEqual(["uci"]);
		// the counter was reset by the explicit re-boot: a crash now backs off from the first step
		(h.boots[h.boots.length - 1] as FakeStockfishWeb).fail("again");
		expect(h.sched.pending).toBe(1);
		h.sched.advance(steps[0] as number);
		expect(h.bootCalls).toHaveLength(boots + 2);
	});

	it("a second consecutive crash of the full build reboots as the small net, marked fallbackFrom", async () => {
		const h = setup();
		h.host.handle({ kind: "configure", variant: "full", threads: 4 });
		await flush();
		let sf = h.boots[h.boots.length - 1] as FakeStockfishWeb;
		expect(h.bootCalls).toEqual(["full"]);
		// First crash: the ordinary backoff and a reboot of the same build.
		sf.fail("worker sent an error! table index is out of bounds");
		h.sched.advance(TIMINGS.engineRestartBackoffMs[0] as number);
		await flush();
		expect(h.bootCalls).toEqual(["full", "full"]);
		expect(h.host.status().fallbackFrom).toBeUndefined();
		// Second crash: the small-net build instead, from the first backoff step again.
		sf = h.boots[h.boots.length - 1] as FakeStockfishWeb;
		sf.fail("worker sent an error! table index is out of bounds");
		const crashed = h.posted[h.posted.length - 1];
		expect(crashed).toMatchObject({
			kind: "status",
			status: { state: "crashed", variant: "smallnet", fallbackFrom: "full" },
		});
		h.sched.advance(TIMINGS.engineRestartBackoffMs[0] as number);
		await flush();
		expect(h.bootCalls).toEqual(["full", "full", "smallnet"]);
		expect(h.host.status()).toMatchObject({
			state: "ready",
			variant: "smallnet",
			fallbackFrom: "full",
		});
		// The SW asking for `full` again (a reconnect's configure) is answered by the fallback.
		const boots = h.bootCalls.length;
		h.host.handle({ kind: "configure", variant: "full", threads: 4 });
		await flush();
		expect(h.bootCalls).toHaveLength(boots);
		expect(h.host.status()).toMatchObject({ variant: "smallnet", fallbackFrom: "full" });
		// An explicit restart is the way back to the requested build.
		h.host.handle({ kind: "restart" });
		await flush();
		expect(h.bootCalls).toEqual(["full", "full", "smallnet", "full"]);
		expect(h.host.status()).toMatchObject({ state: "ready", variant: "full" });
		expect(h.host.status().fallbackFrom).toBeUndefined();
	});

	it("asking for the small net while on the fallback simply keeps it, fallback forgotten", async () => {
		const h = setup();
		h.host.handle({ kind: "configure", variant: "full", threads: 4 });
		await flush();
		for (let i = 0; i < 2; i++) {
			(h.boots[h.boots.length - 1] as FakeStockfishWeb).fail("crash");
			h.sched.advance(TIMINGS.engineRestartBackoffMs[0] as number);
			await flush();
		}
		expect(h.host.status()).toMatchObject({ variant: "smallnet", fallbackFrom: "full" });
		const boots = h.bootCalls.length;
		h.host.handle({ kind: "configure", variant: "smallnet", threads: 4 });
		await flush();
		expect(h.bootCalls).toHaveLength(boots);
		expect(h.host.status().variant).toBe("smallnet");
		expect(h.host.status().fallbackFrom).toBeUndefined();
		// …and a later request for `full` is a real variant change again.
		h.host.handle({ kind: "configure", variant: "full", threads: 4 });
		await flush();
		expect(h.bootCalls).toHaveLength(boots + 1);
		expect(h.host.status().variant).toBe("full");
	});

	it("after giving up, configuring the same variant starts a fresh download attempt", async () => {
		const h = setup();
		let sf = await booted(h);
		const steps = TIMINGS.engineRestartBackoffMs;
		for (let i = 0; i <= steps.length; i++) {
			sf.fail(`crash ${i}`);
			h.sched.advance(steps[Math.min(i, steps.length - 1)] as number);
			await flush();
			sf = h.boots[h.boots.length - 1] as FakeStockfishWeb;
		}
		expect(h.host.status().state).toBe("crashed");
		const boots = h.bootCalls.length;
		h.host.handle({ kind: "configure", variant: "smallnet", threads: 1 });
		await flush();
		expect(h.bootCalls).toHaveLength(boots + 1);
		expect(h.host.status().state).toBe("ready");
	});

	it("a BAD_NNUE error evicts the loaded nets from the store before rebooting", async () => {
		const h = setup();
		const sf = await booted(h);
		sf.fail("BAD_NNUE nn-aaaaaaaaaaaa.nnue");
		await flush();
		expect(h.deleted).toEqual(NETS);
		expect(h.host.status().state).toBe("crashed");
		h.sched.advance(TIMINGS.engineRestartBackoffMs[0]);
		await flush();
		expect(h.host.status().state).toBe("ready");
	});

	it("a boot failure (e.g. missing isolation) is reported as crashed with that error and retried", async () => {
		const h = setup();
		h.failNextBoot("cross-origin isolation missing");
		h.host.handle({ kind: "configure", variant: "smallnet", threads: 1 });
		await flush();
		expect(h.host.status()).toMatchObject({
			state: "crashed",
			error: "cross-origin isolation missing",
		});
		h.sched.advance(TIMINGS.engineRestartBackoffMs[0]);
		await flush();
		expect(h.bootCalls).toHaveLength(2);
		expect(h.host.status().state).toBe("ready");
	});

	it("dispose cancels pending reboots and detaches the engine", async () => {
		const h = setup();
		const sf = await booted(h);
		sf.fail("boom");
		expect(h.sched.pending).toBe(1);
		h.host.dispose();
		expect(h.sched.pending).toBe(0);
		expect(sf.commands).toContain("quit");
		sf.emit("uciok");
		expect(h.lines()).toEqual([]);
	});
});

// ── serveEnginePort: the Maia-3 policy routes (2026-09-11) ─────────────────────────────────
// Over the simulator's runtime ports like `test/core/engine/remote-engine.test.ts`: `policy` and
// `policy-warm` reach a served policy host and its replies come back; `configure.warmPolicy`
// pre-warms that size once; without a policy host both answer not-available.

describe("serveEnginePort policy routes", () => {
	let sim: Simulator;
	let sw: SwContext | undefined;
	let off: OffscreenContext | undefined;
	const prevChrome = (globalThis as Record<string, unknown>).chrome;
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 8; i++) await sim.time.runMicrotasks();
	};
	const query = (id: string): Extract<EnginePortCommand, { kind: "policy" }> => ({
		kind: "policy",
		id,
		inputs: {
			size: "79m",
			fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
			historyFens: [],
			selfElo: 1500,
			oppoElo: 1500,
		},
	});
	const hostDeps = (post: (m: EnginePortMessage) => void) =>
		new EngineHost({
			boot: async () => new Promise<BootedEngine>(() => {}),
			nnueStore: { get: async () => new Uint8Array(1) },
			post,
		});

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

	it("routes policy and policy-warm to the served host and posts its replies back", async () => {
		const calls: string[] = [];
		off = await bootOffscreenContext(sim, {
			entry: () => {
				serveEnginePort({
					createStore: () => ({ handleChunk: () => {}, abortAll: () => {} }),
					createHost: hostDeps,
					createPolicy: () => ({
						handle: async (cmd) => {
							calls.push(`handle:${cmd.id}`);
							return {
								kind: "policy-result",
								id: cmd.id,
								moves: [["e2e4", 1]],
								wdl: [0.3, 0.4, 0.3],
								size: cmd.inputs.size,
								ms: 9,
							};
						},
						warm: async (size) => {
							calls.push(`warm:${size}`);
							return { kind: "policy-status", size, loadMs: 120 };
						},
						resident: () => null,
						dispose: () => {
							calls.push("dispose");
						},
					}),
				});
			},
		});
		const engine = await (sw as SwContext).run(async () => {
			const e = new RemoteEngine({ variant: "smallnet", threads: 1 });
			await e.ready;
			return e;
		});
		const seen: EnginePortMessage[] = [];
		engine.onMessage((m) => seen.push(m));
		engine.post({ kind: "policy-warm", size: "79m" });
		engine.post(query("p2"));
		await settle();
		// No `warmPolicy` on this engine, so nothing was pre-warmed on configure.
		expect(calls).toEqual(["warm:79m", "handle:p2"]);
		expect(seen).toContainEqual({ kind: "policy-status", size: "79m", loadMs: 120 });
		expect(seen).toContainEqual({
			kind: "policy-result",
			id: "p2",
			moves: [["e2e4", 1]],
			wdl: [0.3, 0.4, 0.3],
			size: "79m",
			ms: 9,
		});
		engine.dispose();
	});

	it("pre-warms configure.warmPolicy once, not again on later configures, and the stop disposes the policy host", async () => {
		const calls: string[] = [];
		let stop: () => void = () => {};
		off = await bootOffscreenContext(sim, {
			entry: () => {
				stop = serveEnginePort({
					createStore: () => ({ handleChunk: () => {}, abortAll: () => {} }),
					createHost: hostDeps,
					createPolicy: () => ({
						handle: async (cmd) => ({
							kind: "policy-result",
							id: cmd.id,
							moves: null,
							error: "unused",
						}),
						warm: async (size) => {
							calls.push(`warm:${size}`);
							return { kind: "policy-status", size, loadMs: 1 };
						},
						resident: () => null,
						dispose: () => {
							calls.push("dispose");
						},
					}),
				}).stop;
			},
		});
		const engine = await (sw as SwContext).run(async () => {
			const e = new RemoteEngine({ variant: "smallnet", threads: 1, warmPolicy: MAIA.defaultSize });
			await e.ready;
			return e;
		});
		await settle();
		expect(calls).toEqual([`warm:${MAIA.defaultSize}`]);
		// The same size on every later configure is not warmed again — every reconnect re-sends
		// `configure`, and the session's `setWarmPolicy` names the same (only) size since 2026-09-13.
		engine.configure("smallnet", 2);
		await settle();
		expect(calls).toEqual([`warm:${MAIA.defaultSize}`]);
		engine.setWarmPolicy(MAIA.defaultSize);
		engine.configure("smallnet", 2);
		await settle();
		expect(calls).toEqual([`warm:${MAIA.defaultSize}`]);
		engine.dispose();
		await (off as OffscreenContext).run(() => stop());
		expect(calls[calls.length - 1]).toBe("dispose");
	});

	it("without a policy host, policy and policy-warm answer not-available", async () => {
		off = await bootOffscreenContext(sim, {
			entry: () => {
				serveEnginePort({
					createStore: () => ({ handleChunk: () => {}, abortAll: () => {} }),
					createHost: hostDeps,
				});
			},
		});
		const engine = await (sw as SwContext).run(async () => {
			const e = new RemoteEngine({ variant: "smallnet", threads: 1, warmPolicy: "79m" });
			await e.ready;
			return e;
		});
		const seen: EnginePortMessage[] = [];
		engine.onMessage((m) => seen.push(m));
		engine.post(query("p1"));
		engine.post({ kind: "policy-warm", size: "79m" });
		await settle();
		expect(seen).toContainEqual({
			kind: "policy-result",
			id: "p1",
			moves: null,
			error: POLICY_NOT_AVAILABLE,
		});
		expect(seen).toContainEqual({ kind: "policy-status", size: null, error: POLICY_NOT_AVAILABLE });
		engine.dispose();
	});
});
