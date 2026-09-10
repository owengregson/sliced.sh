// test/behavioral/game/game-stack.test.ts — Task 30 (I-7): the *real* per-worker stack, built by
// `createGameStack` exactly as `service-worker.ts` builds it, against a fake offscreen engine host.
// The other behavioural files hand-assemble an equivalent stack so they can script the engine at
// the UCI level; this one exists so the two cannot silently diverge.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
import { setSettings } from "@core/storage/settings-storage";
import { type BootHooks, EngineHost, serveEnginePort } from "@offscreen/engine-host";
import type { BootedEngine } from "@offscreen/stockfish-loader";
import { __resetServiceSystemsCache, bootstrapServiceSystems } from "@service/bootstrap";
import { createGameStack, type GameStack } from "@service/game-stack";
import { PanelBroadcaster, type SnapshotSources } from "@service/panel-broadcaster";
import { createSimulator, type Simulator } from "@test/sim";
import { bootOffscreenContext, type OffscreenContext } from "@test/sim/contexts/offscreen-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import { createSimulatedSite, type SimulatedSite } from "@test/sim/telemetry/sim-site";
import type { EngineVariant } from "@typedefs/engine";
import { FakeStockfishWeb } from "../../fakes/stockfish";

const START = 1_700_000_000_000;

let sim: Simulator;
let sw: SwContext | undefined;
let off: OffscreenContext | undefined;
let site: SimulatedSite | undefined;
let stack: GameStack | undefined;
let broadcaster: PanelBroadcaster | undefined;
let router: MessageRouter | undefined;
let tabId = 0;

/** The offscreen document the real `RemoteEngine` connects to (`ensureOffscreen` is a no-op here). */
async function bootOffscreen(): Promise<void> {
	const boot = async (_variant: EngineVariant, hooks: BootHooks): Promise<BootedEngine> => {
		const sf = new FakeStockfishWeb();
		sf.listen = hooks.listen;
		sf.onError = hooks.onError;
		hooks.onLoadingNnue([...sf.recommended]);
		return { sf, module: "sf_18_smallnet.js", nnue: [...sf.recommended] };
	};
	off = await bootOffscreenContext(sim, {
		entry: () => {
			serveEnginePort({
				createStore: () => ({ handleChunk: () => {}, abortAll: () => {} }),
				createHost: (post) =>
					new EngineHost({ boot, nnueStore: { get: async () => new Uint8Array(1) }, post }),
			});
		},
	});
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await sim.time.runMicrotasks();
};

beforeEach(async () => {
	sim = createSimulator({ startAt: START });
	sim.time.install();
	tabId = sim.openTab("https://www.chess.com/game/174252022572", { active: true }).tabId;
	await bootOffscreen();
	sw = await bootSwContext(sim, {
		entry: () => {
			const systems = bootstrapServiceSystems({ forceValid: true });
			router = installMessageRouter();
			let sources: SnapshotSources | null = null;
			broadcaster = new PanelBroadcaster({
				session: (id) => sources?.session(id) ?? null,
				executor: (id) => sources?.executor(id) ?? null,
				get hand() {
					return sources?.hand ?? null;
				},
				engineStatus: () => sources?.engineStatus(),
				license: () => systems.license.getState(),
			});
			stack = createGameStack({
				systems,
				router: router as MessageRouter,
				broadcaster: broadcaster as PanelBroadcaster,
				env: { hardwareConcurrency: 4, sab: true },
			});
			sources = stack.registry;
			systems.sessions = stack.registry;
			systems.engine = stack.engine;
			router.install();
		},
	});
	site = await createSimulatedSite(sim, tabId, { myColor: "w" });
	await settle();
});

afterEach(async () => {
	await sw?.run(() => {
		broadcaster?.dispose();
		stack?.dispose();
		router?.dispose();
		__resetServiceSystemsCache();
	});
	await site?.dispose();
	await off?.teardown();
	await sw?.teardown();
	sim.time.uninstall();
	await sim.dispose();
	sw = undefined;
	off = undefined;
	site = undefined;
	stack = undefined;
	broadcaster = undefined;
	router = undefined;
});

describe("createGameStack: the real service-worker stack", () => {
	it("builds the whole stack and opens a session for a connected game port", async () => {
		const built = stack as GameStack;
		// The port connect alone opens the session; `hello` is what moves it out of `idle`.
		expect(built.registry.sessionFor(tabId)).not.toBeNull();
		expect(built.registry.sessionFor(tabId)?.currentState()).toBe("idle");
		await (sw as SwContext).run(async () => {
			(site as SimulatedSite).hello();
			await settle();
		});
		// `SnapshotSources` is satisfied for real: the panel sees the tab's session, not the idle one.
		const snapshot = await (sw as SwContext).run(() =>
			(broadcaster as PanelBroadcaster).snapshotFor(null)
		);
		expect(snapshot.session.state).toBe("waiting-for-game");
		expect(snapshot.site).toBe("chesscom");
		expect(snapshot.executor.debuggerAttached).toBe(false);
	});

	it("reaches the offscreen engine: the transport is ready and `ucinewgame` goes out on a game", async () => {
		const built = stack as GameStack;
		await (sw as SwContext).run(async () => {
			await built.transport.ready;
			await settle();
		});
		expect(built.transport.status().state).not.toBe("crashed");

		await (sw as SwContext).run(async () => {
			(site as SimulatedSite).hello();
			(site as SimulatedSite).startGame();
			await settle();
		});
		expect(built.registry.sessionFor(tabId)?.currentState()).toBe("live:opponent-turn");
		expect(built.controller.status().gameId).toBe((site as SimulatedSite).gameId);
	});

	it("a settings write reaches the sessions (the content re-push wiring exists)", async () => {
		await (sw as SwContext).run(async () => {
			(site as SimulatedSite).hello();
			await settle();
		});
		const before = (site as SimulatedSite).commands().filter((c) => c.kind === "settings").length;
		expect(before).toBeGreaterThan(0);

		await (sw as SwContext).run(async () => {
			await setSettings({ automation: { highlightMoves: true } });
			await settle();
		});
		const after = (site as SimulatedSite).commands().filter((c) => c.kind === "settings");
		expect(after.length).toBeGreaterThan(before);
		expect(after.at(-1)).toEqual({ kind: "settings", highlightMoves: true });
	});

	it("dispose() releases the stack: the game port registry is empty and the timing log is flushed", async () => {
		const built = stack as GameStack;
		await (sw as SwContext).run(async () => {
			built.timingLog.append({
				gameId: "g",
				ply: 1,
				mode: "normal",
				plannedMs: 1000,
				actualMs: null,
				alloc: 1,
				clockMs: 1000,
				comp: 1,
				eps: 0,
				topTerms: [],
				persona: "balanced",
			});
			built.dispose();
			await settle();
		});
		expect(built.link.tabs()).toEqual([]);
		expect(built.registry.all()).toEqual([]);
		expect(Array.isArray(sim.storage.data.local[LOCAL_KEYS.timingLog])).toBe(true);
		stack = undefined; // already disposed
	});
});
