// test/behavioral/game/cold-start.test.ts — the MV3 cold-start ordering, against the *real*
// `createGameStack` wiring (the other behavioural files hand-assemble the stack and so cannot see
// this): a worker woken by a queued port connect can have its `GameSession` built — and the first
// `position` of the game delivered — before the `chrome.storage.local` settings read resolves, so
// that ply is gated on `DEFAULT_SETTINGS.enabled` rather than on what the user actually stored
// (§4.4). Nothing retries it: the content script's reconnect replay is swallowed by the feed
// dedupe. The first read therefore has to reach the sessions like any other settings change.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
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

/**
 * What the user stored: the assistant on, marks on. `DEFAULT_SETTINGS` is neither on this lane.
 * The opening book is off because this stack's `BookPolicy` is the real one over a network
 * `ExplorerClient`, which nothing answers in the simulator — the subject here is the ordering of
 * the settings read against the feed, not §7.3.
 */
const STORED = {
	enabled: true,
	automation: { highlightMoves: true },
	strength: { useOpeningBook: false },
};

let sim: Simulator;
let sw: SwContext | undefined;
let off: OffscreenContext | undefined;
let site: SimulatedSite | undefined;
let stack: GameStack | undefined;
let broadcaster: PanelBroadcaster | undefined;
let router: MessageRouter | undefined;
let tabId = 0;
/** Settings reads the test is holding back (the cold-start window), in call order. */
let heldReads: Array<() => void> = [];
/** Every UCI command the offscreen engine was given (the fake's own record). */
let engineCommands: string[] = [];
let releaseReads: () => void = () => {};

const settle = async (): Promise<void> => {
	for (let i = 0; i < 8; i++) await sim.time.runMicrotasks();
};

/**
 * Hold every `chrome.storage.local.get(LOCAL_KEYS.settings)` until the test lets it through, so
 * the port connect, `hello`, `gameStarted` and the first `position` all land while the worker is
 * still holding `DEFAULT_SETTINGS`. Every other key reads normally (the license gate, the timing
 * log and the session stats all boot as usual).
 */
function holdSettingsReads(): void {
	const area = sim.chrome.storage.local as unknown as {
		get: (keys: unknown, cb?: (items: Record<string, unknown>) => void) => unknown;
	};
	const real = area.get.bind(area);
	area.get = (keys: unknown, cb?: (items: Record<string, unknown>) => void): unknown => {
		if (keys === LOCAL_KEYS.settings && typeof cb === "function") {
			heldReads.push(() => void real(keys, cb));
			return undefined;
		}
		return real(keys, cb);
	};
	releaseReads = (): void => {
		area.get = real;
		for (const read of heldReads.splice(0)) read();
	};
}

/** The offscreen host with a Stockfish that answers: `uciok` / `readyok` / lines + `bestmove`. */
async function bootOffscreen(): Promise<void> {
	const boot = async (_variant: EngineVariant, hooks: BootHooks): Promise<BootedEngine> => {
		const sf = new FakeStockfishWeb();
		engineCommands = sf.commands;
		sf.listen = hooks.listen;
		sf.onError = hooks.onError;
		const send = sf.uci.bind(sf);
		sf.uci = (command: string): void => {
			send(command);
			// Deferred: the host is still bookkeeping the command it just wrote.
			queueMicrotask(() => {
				if (command === "uci") sf.emit("uciok");
				else if (command === "isready") sf.emit("readyok");
				else if (command.startsWith("go"))
					sf.emit(
						"info depth 12 multipv 1 score cp 30 nodes 5000 nps 100000 time 10 pv e2e4 e7e5",
						"info depth 12 multipv 2 score cp 18 nodes 5000 nps 100000 time 10 pv d2d4 d7d5",
						"info depth 12 multipv 3 score cp 9 nodes 5000 nps 100000 time 10 pv g1f3 g8f6",
						"bestmove e2e4"
					);
			});
		};
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

beforeEach(async () => {
	heldReads = [];
	sim = createSimulator({ startAt: START, storageLocal: { [LOCAL_KEYS.settings]: STORED } });
	sim.time.install();
	tabId = sim.openTab("https://lichess.org/abcd1234", { active: true }).tabId;
	await bootOffscreen();
	holdSettingsReads();
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

describe("createGameStack: the MV3 cold start (§4.4)", () => {
	it("a position delivered before the first settings read is still analysed once it lands", async () => {
		const worker = sw as SwContext;
		const built = stack as GameStack;

		// The whole game opening sequence arrives inside the cold-start window.
		site = await createSimulatedSite(sim, tabId, { site: "lichess", myColor: "w" });
		await worker.run(async () => {
			(site as SimulatedSite).hello();
			(site as SimulatedSite).startGame();
			(site as SimulatedSite).arrive(null, { w: 300_000, b: 300_000 });
			await settle();
			await sim.time.advance(200);
		});
		const page = site as SimulatedSite;
		const session = built.registry.sessionFor(tabId);
		expect(session).not.toBeNull();
		expect(heldReads).not.toHaveLength(0); // the read really was still outstanding
		// Gated on `DEFAULT_SETTINGS.enabled`, which is not what the user stored: nothing analysed,
		// and the content script was told the default `highlightMoves`.
		expect(session?.recommendation()).toBeNull();
		expect(engineCommands.filter((c) => c.startsWith("go"))).toEqual([]);
		const gate = (): boolean | undefined => {
			const pushed = page.commands().filter((c) => c.kind === "settings");
			const last = pushed.at(-1);
			return last && last.kind === "settings" ? last.highlightMoves : undefined;
		};
		expect(gate()).toBe(false);

		// The read lands. The ply is never re-delivered (the feed dedupe swallows the replay), so
		// the session has to pick this position up off the settings change itself.
		await worker.run(async () => {
			releaseReads();
			await settle();
			for (let i = 0; i < 40 && built.registry.sessionFor(tabId)?.recommendation() === null; i++)
				await sim.time.advance(50);
		});
		expect(built.getSettings().enabled).toBe(true);
		expect(gate()).toBe(true);
		const rec = built.registry.sessionFor(tabId)?.recommendation();
		expect(rec).not.toBeNull();
		expect(rec?.fen).toBe(page.board.fen());
		// The ply was searched after all — for the position that arrived inside the window.
		expect(engineCommands).toContain(`position fen ${page.board.fen()}`);
		expect(engineCommands.filter((c) => c.startsWith("go depth"))).not.toEqual([]);
		expect(built.registry.sessionFor(tabId)?.currentState()).toBe("live:my-turn:recommended");
	});
});
