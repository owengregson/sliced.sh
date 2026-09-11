// test/behavioral/game/game-stack.test.ts — Task 30 (I-7): the *real* per-worker stack, built by
// `createGameStack` exactly as `service-worker.ts` builds it, against a fake offscreen engine host.
// The other behavioural files hand-assemble an equivalent stack so they can script the engine at
// the UCI level; this one exists so the two cannot silently diverge.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
import { setSettings } from "@core/storage/settings-storage";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta as TimingGameMeta } from "@core/timing/types";
import { type BootHooks, EngineHost, serveEnginePort } from "@offscreen/engine-host";
import type { BootedEngine } from "@offscreen/stockfish-loader";
import type { TimingCommand, TimingResultMessage } from "@offscreen/timing-inference";
import { __resetServiceSystemsCache, bootstrapServiceSystems } from "@service/bootstrap";
import { createGameStack, type GameStack } from "@service/game-stack";
import { PanelBroadcaster, type SnapshotSources } from "@service/panel-broadcaster";
import { createSimulator, type Simulator } from "@test/sim";
import { bootOffscreenContext, type OffscreenContext } from "@test/sim/contexts/offscreen-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import { createSimulatedSite, type SimulatedSite } from "@test/sim/telemetry/sim-site";
import type { EngineVariant } from "@typedefs/engine";
import { ctx } from "../../core/timing/helpers";
import { FAKE_ID_LINES } from "../../fakes/engine-transport";
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
let hostedEngines: FakeStockfishWeb[] = [];
let timingRequests: Array<{ command: TimingCommand; resolve(result: TimingResultMessage): void }> =
	[];

/** This integration fixture must complete actual UCI handshakes, not only report host ready. */
class RespondingStockfish extends FakeStockfishWeb {
	override uci(command: string): void {
		super.uci(command);
		if (command === "uci") queueMicrotask(() => this.emit(...FAKE_ID_LINES));
		else if (command === "isready") queueMicrotask(() => this.emit("readyok"));
		else if (command === "stop") queueMicrotask(() => this.emit("bestmove e2e4"));
	}
}

/** The offscreen document the real `RemoteEngine` connects to (`ensureOffscreen` is a no-op here). */
async function bootOffscreen(): Promise<void> {
	const boot = async (_variant: EngineVariant, hooks: BootHooks): Promise<BootedEngine> => {
		const sf = new RespondingStockfish();
		hostedEngines.push(sf);
		sf.listen = hooks.listen;
		sf.onError = hooks.onError;
		hooks.onLoadingNnue([...sf.recommended]);
		return { sf, module: "sf_18_smallnet.js", nnue: [...sf.recommended] };
	};
	off = await bootOffscreenContext(sim, {
		entry: () => {
			serveEnginePort({
				createStore: () => ({ handleChunk: () => {}, abortAll: () => {} }),
				createModelStore: () => ({ handleChunk: () => {}, abortAll: () => {} }),
				createTiming: () => ({
					warm: async () => {},
					dispose: () => {},
					handle: (command) => new Promise((resolve) => timingRequests.push({ command, resolve })),
				}),
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
	hostedEngines = [];
	timingRequests = [];
	// §4.4: the session gates every acting path (and the content-side `highlightMoves` gate) on the
	// switch, so the stored fixture says what it means — a user with the assistant on — instead of
	// inheriting `DEFAULT_SETTINGS` and changing meaning when that moves. Same seed as
	// `test/behavioral/game/harness.ts`.
	sim = createSimulator({
		startAt: START,
		storageLocal: { [LOCAL_KEYS.settings]: { enabled: true } },
	});
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
	it("isolates same-position timing inference and reset generations between game sessions", async () => {
		const built = stack as GameStack;
		const models = new Map<string, TimingModel>();
		const original = TimingModel.prototype.startGame;
		const spy = spyOn(TimingModel.prototype, "startGame").mockImplementation(function (
			this: TimingModel,
			meta: TimingGameMeta
		) {
			original.call(this, meta);
			models.set(meta.gameId, this);
		});
		const secondTab = sim.openTab("https://www.chess.com/game/174252022573").tabId;
		const second = await createSimulatedSite(sim, secondTab, { gameId: "timing-b", myColor: "w" });
		try {
			await (sw as SwContext).run(async () => {
				(site as SimulatedSite).hello();
				(site as SimulatedSite).startGame({ gameId: "timing-a" });
				second.hello();
				second.startGame();
				await settle();
				const a = models.get("timing-a")!;
				const b = models.get("timing-b")!;
				expect(a).toBeDefined();
				expect(b).toBeDefined();
				expect(built.registry.sessionFor(secondTab)).not.toBe(built.registry.sessionFor(tabId));
				const ca = ctx({ targetElo: 1650, myClockMs: 180_000, oppClockMs: 170_000 });
				const cb = ctx({ targetElo: 2300, myClockMs: 30_000, oppClockMs: 50_000 });
				const answer = (at: number, bucket: number) => {
					const request = timingRequests[at]!;
					request.resolve({
						kind: "timing-result",
						id: request.command.id,
						band: request.command.inputs.band,
						probs: Array.from({ length: 30 }, (_, i) => (i === bucket ? 1 : 0)),
						ms: 1,
					});
				};
				const first = a.prepare(ca);
				await settle();
				answer(0, 6);
				await first;
				// A's inference is ready while its independent engine search could still be running.
				const other = b.prepare(cb);
				await settle();
				answer(1, 8);
				await other;
				expect(timingRequests.map(({ command }) => command.inputs)).toMatchObject([
					{ rating: 1650, band: "1500_1600", playerClockS: 180, opponentClockS: 170 },
					{ rating: 2300, band: "1800_1900", playerClockS: 30, opponentClockS: 50 },
				]);
				expect(a.planMove(ca).rationale.join(" ")).toContain("chessmimic band=1500_1600 bucket 6");
				expect(b.planMove(cb).rationale.join(" ")).toContain("chessmimic band=1800_1900 bucket 8");
				// Restart A while its next request is pending; late completion must not revive it,
				// and A's reset must not invalidate B's already prepared distribution.
				const cancelled = a.prepare(ca);
				await settle();
				a.startGame({
					gameId: "timing-a-next",
					site: "chesscom",
					targetElo: 1650,
					profile: "balanced",
					baseSec: 180,
					incSec: 0,
				});
				answer(2, 6);
				await cancelled;
				expect(a.planMove(ca).rationale.join(" ")).toContain("fallback");
				expect(b.planMove(cb).rationale.join(" ")).toContain("chessmimic band=1800_1900 bucket 8");
			});
		} finally {
			spy.mockRestore();
			await second.dispose();
		}
	});
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
		expect(built.engine.state()).toBe("idle");
		const sf = hostedEngines.at(-1) as FakeStockfishWeb;
		const resetsBeforeGame = sf.commands.filter((command) => command === "ucinewgame").length;

		await (sw as SwContext).run(async () => {
			(site as SimulatedSite).hello();
			(site as SimulatedSite).startGame();
			await settle();
		});
		expect(built.registry.sessionFor(tabId)?.currentState()).toBe("live:opponent-turn");
		expect(built.controller.status().gameId).toBe((site as SimulatedSite).gameId);
		expect(sf.commands.filter((command) => command === "ucinewgame")).toHaveLength(
			resetsBeforeGame + 1
		);
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

	it("a first-position ponder follows the game reset through the actual offscreen port", async () => {
		const built = stack as GameStack;
		const sf = hostedEngines.at(-1) as FakeStockfishWeb;
		sf.commands.length = 0;
		await (sw as SwContext).run(async () => {
			(site as SimulatedSite).hello();
			(site as SimulatedSite).startGame();
			(site as SimulatedSite).arrive("e2e4", { w: 60_000, b: 60_000 });
			await settle();
		});
		expect(built.controller.status().gameId).toBe((site as SimulatedSite).gameId);
		const reset = sf.commands.indexOf("ucinewgame");
		const search = sf.commands.findIndex((command) => command.startsWith("go infinite"));
		expect(reset).toBeGreaterThanOrEqual(0);
		expect(search).toBeGreaterThan(reset);
		expect(sf.commands.slice(reset, search)).toContain("isready");
	});

	it("a high target selects the full host and applies unlimited strength before its next search", async () => {
		const built = stack as GameStack;
		await (sw as SwContext).run(async () => {
			await setSettings({ strength: { targetElo: 3800 } });
			await settle();
		});
		expect(built.transport.status().variant).toBe("full");
		expect(built.engine.state()).toBe("idle");
		const sf = hostedEngines.at(-1) as FakeStockfishWeb;
		expect(sf.commands).toContain("setoption name UCI_LimitStrength value false");
		expect(sf.commands).not.toContain("setoption name UCI_Elo value 3800");
		await (sw as SwContext).run(async () => {
			(site as SimulatedSite).hello();
			(site as SimulatedSite).startGame();
			(site as SimulatedSite).arrive("e2e4", { w: 60_000, b: 60_000 });
			await settle();
		});
		expect(built.controller.status().gameId).toBe((site as SimulatedSite).gameId);
		const search = sf.commands.findIndex((command) => command.startsWith("go infinite"));
		expect(search).toBeGreaterThan(
			sf.commands.indexOf("setoption name UCI_LimitStrength value false")
		);
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
