// test/behavioral/game/cold-start.test.ts — the MV3 cold-start ordering, against the *real*
// `createGameStack` wiring (the other behavioural files hand-assemble the stack and so cannot see
// this): a worker woken by a queued port connect can have its `GameSession` built — and the first
// `position` of the game delivered — before the `chrome.storage.local` settings read resolves.
//
// §4.4 says the switch decides whether anything is analysed, and `DEFAULT_SETTINGS` is not the
// user's answer in *either* direction: guessing it fails open for half the users, and which half
// changes whenever the default changes. So the window holds — neither on nor off — and the first
// read's fan-out releases it (`resumeEnabled`). Nothing re-delivers that ply: the content script's
// reconnect replay is swallowed by the feed dedupe, so releasing it is the only chance it gets.
//
// The two cases below are the same window with opposite stored values, and **neither names
// `DEFAULT_SETTINGS`**: whatever the default is, one of them has it wrong, so the pair cannot be
// satisfied by a session that guesses.
import { afterEach, describe, expect, it } from "bun:test";
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
 * What the user stored, with `enabled` supplied per test. The opening book is off because this
 * stack's `BookPolicy` is the real one over a network `ExplorerClient`, which nothing answers in
 * the simulator — the subject here is the ordering of the settings read against the feed, not §7.3.
 */
const stored = (enabled: boolean): Record<string, unknown> => ({
	enabled,
	automation: { highlightMoves: true },
	strength: { useOpeningBook: false },
});

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

/** Boot the worker with `enabled` stored and its settings read held back. */
async function boot(enabled: boolean): Promise<void> {
	heldReads = [];
	sim = createSimulator({
		startAt: START,
		storageLocal: { [LOCAL_KEYS.settings]: stored(enabled) },
	});
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
}

/**
 * The whole game opening sequence, delivered inside the cold-start window, plus the assertions
 * that hold there whatever was stored: nothing searched, nothing recommended, no marks enabled,
 * nothing armed.
 */
async function openGameInsideTheWindow(): Promise<SimulatedSite> {
	const worker = sw as SwContext;
	const built = stack as GameStack;
	site = await createSimulatedSite(sim, tabId, { site: "lichess", myColor: "w" });
	const page = site;
	await worker.run(async () => {
		page.hello();
		page.startGame();
		page.arrive(null, { w: 300_000, b: 300_000 });
		await settle();
		await sim.time.advance(200);
	});
	const session = built.registry.sessionFor(tabId);
	expect(session).not.toBeNull();
	expect(heldReads).not.toHaveLength(0); // the read really was still outstanding
	// The window holds: the session has the position (it is following the game) and has acted on
	// nothing. None of this depends on what `DEFAULT_SETTINGS.enabled` happens to be.
	expect(session?.view().gameId).toBe(page.gameId);
	expect(session?.view().sideToMove).toBe("w");
	expect(session?.recommendation()).toBeNull();
	expect(engineCommands.filter((c) => c.startsWith("go"))).toEqual([]);
	expect(highlightGate(page)).toBe(false);
	expect(built.registry.executor(tabId)?.isArmed() ?? false).toBe(false);
	expect(sim.debugger.commands).toEqual([]);
	return page;
}

/** The `highlightMoves` gate the worker last pushed to the content script (§13.3 rule 4). */
function highlightGate(page: SimulatedSite): boolean | undefined {
	const pushed = page.commands().filter((c) => c.kind === "settings");
	const last = pushed.at(-1);
	return last && last.kind === "settings" ? last.highlightMoves : undefined;
}

/** Let the held settings read through, then give the session room to act on it. */
async function releaseAndSettle(until: () => boolean): Promise<void> {
	await (sw as SwContext).run(async () => {
		releaseReads();
		await settle();
		for (let i = 0; i < 40 && !until(); i++) await sim.time.advance(50);
	});
}

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
	it("stored on: the held position is analysed once the read lands", async () => {
		await boot(true);
		const built = stack as GameStack;
		const page = await openGameInsideTheWindow();

		// The read lands. The ply is never re-delivered, so the session has to pick this position up
		// off the settings change itself.
		await releaseAndSettle(() => built.registry.sessionFor(tabId)?.recommendation() !== null);

		expect(built.getSettings().enabled).toBe(true);
		expect(built.settingsKnown()).toBe(true);
		expect(highlightGate(page)).toBe(true);
		const rec = built.registry.sessionFor(tabId)?.recommendation();
		expect(rec).not.toBeNull();
		expect(rec?.fen).toBe(page.board.fen());
		// The ply was searched after all — for the position that arrived inside the window.
		expect(engineCommands).toContain(`position fen ${page.board.fen()}`);
		expect(engineCommands.filter((c) => c.startsWith("go depth"))).not.toEqual([]);
		expect(built.registry.sessionFor(tabId)?.currentState()).toBe("live:my-turn:recommended");
	});

	it("stored off: the held position stays dropped once the read lands", async () => {
		await boot(false);
		const built = stack as GameStack;
		const page = await openGameInsideTheWindow();

		// The read lands — with the switch off. Releasing the window must not release the ply.
		await releaseAndSettle(() => false);

		expect(built.getSettings().enabled).toBe(false);
		expect(built.settingsKnown()).toBe(true);
		expect(built.registry.sessionFor(tabId)?.recommendation()).toBeNull();
		expect(engineCommands.filter((c) => c.startsWith("go"))).toEqual([]);
		expect(highlightGate(page)).toBe(false);
		expect(built.registry.executor(tabId)?.isArmed() ?? false).toBe(false);
		// Nothing was ever dispatched to the page, and the board is untouched.
		expect(sim.debugger.commands).toEqual([]);
		expect(page.board.lastMove()).toBeNull();

		// And it stays that way: a further position is gated like any other (§4.4).
		await (sw as SwContext).run(async () => {
			page.arrive(null, { w: 299_000, b: 300_000 });
			await settle();
			await sim.time.advance(30_000);
		});
		expect(built.registry.sessionFor(tabId)?.recommendation()).toBeNull();
		expect(engineCommands.filter((c) => c.startsWith("go"))).toEqual([]);
	});
});
