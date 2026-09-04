// test/offscreen/engine-host.test.ts
import { describe, expect, it } from "bun:test";
import type { EnginePortMessage } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { type BootHooks, EngineHost } from "@offscreen/engine-host";
import type { BootedEngine } from "@offscreen/stockfish-loader";
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
		return { sf, module: "sf_18_smallnet.js", nnue: [...recommended] };
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
			version: "sf_18_smallnet.js",
		});
		expect(status.error).toBeUndefined();
	});

	it("forwards uci commands to sf.uci and engine output to the port as lines", async () => {
		const h = setup();
		const sf = await booted(h);
		h.host.handle({ kind: "uci", line: "uci" });
		expect(sf.commands).toEqual(["uci"]);
		sf.emit("id name Stockfish 18", "uciok");
		expect(h.lines()).toEqual(["id name Stockfish 18", "uciok"]);
		expect(h.host.status().version).toBe("Stockfish 18");
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
