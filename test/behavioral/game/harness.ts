// test/behavioral/game/harness.ts — Task 30 Step 2: the whole service-worker game stack on the
// simulator. Real `ContentLink`, `FocusGate`, `HandOwnership`, `DebuggerManager`, `MoveExecutor`,
// `UciEngine` + `EngineController` (over `ScriptedEngineTransport`, the fake offscreen), real
// `TimingModel`, real `SessionRegistry` / `GameSession`, real panel handlers and broadcaster.
// The page half is `createSimulatedSite` — the same one Task 33's telemetry harness drives.
import { onCommand } from "@core/chrome/commands";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import type { GamePortCommand, PanelPortMessage, PanelSnapshot } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { AnalysisCache } from "@core/engine/analysis-cache";
import { UciEngine } from "@core/engine/uci-client";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
import type { SettingsPatch } from "@core/storage/settings-storage";
import { getSettings, onSettingsChanged, setSettings } from "@core/storage/settings-storage";
import { TimingLogWriter } from "@core/timing/timing-log";
import type { DistributionHead } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { defaultScheduler } from "@core/util/scheduler";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { EngineController } from "@service/engine-controller";
import { FocusGate } from "@service/focus-gate";
import type { GameSession } from "@service/game-session";
import { SessionRegistry } from "@service/game-session";
import { HandOwnership } from "@service/hand-ownership";
import { registerContentHandlers } from "@service/handlers/content";
import { registerPanelHandlers } from "@service/handlers/panel";
import { Keepalive } from "@service/keepalive";
import type { MoveExecutor } from "@service/move-executor";
import { PanelBroadcaster } from "@service/panel-broadcaster";
import { createSimulator, type Simulator } from "@test/sim";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import { createSimulatedSite, type SimulatedSite } from "@test/sim/telemetry/sim-site";
import type { Color } from "@typedefs/game";
import type { LicenseState, Settings } from "@typedefs/settings";
import { ScriptedEngineTransport, type ScriptOptions } from "./scripted-engine";

export const START_AT = 1_700_000_000_000;
const LICENSE: LicenseState = { status: "valid", checkedAt: START_AT };

export interface GameHarnessOptions {
	settings?: SettingsPatch;
	myColor?: Color;
	fen?: string;
	/**
	 * The time control the *page* reports. `null` means the site has not answered yet — the
	 * production order on a real live game (§4.3), where it arrives on a later position and
	 * `GameSession.reprofile()` is what consumes it. Use `site.setTimeControl(...)` to deliver it.
	 */
	timeControl?: { baseMs: number; incMs: number } | null;
	/** Forward in-page keybinds to the service worker as `CONTENT_KEYBIND`. */
	sendKeybinds?: boolean;
	/**
	 * Whether the *site* holds a move made on the opponent's turn as a premove (chess.com's own
	 * setting; Fix F). Default `false` — premoves off, the piece snaps back.
	 */
	premoves?: boolean;
	script?: ScriptOptions;
	head?: DistributionHead;
	/** Skip `hello` + `gameStarted` + the first position (a test that drives them itself). */
	manualStart?: boolean;
	/** Per-tab base seed (every per-game draw derives from it). */
	seed?: string;
	/** Game id the page reports (part of the per-game seed). */
	gameId?: string;
	/**
	 * Pre-seed `chrome.storage.local` of the harness's own simulator. A `LOCAL_KEYS.settings` entry
	 * here replaces the seeded `{ enabled: true }` wholesale (`settings` below merges instead).
	 */
	storage?: Record<string, unknown>;
}

export interface GameHarness {
	sim: Simulator;
	sw: SwContext;
	site: SimulatedSite;
	tabId: number;
	router: MessageRouter;
	registry: SessionRegistry;
	broadcaster: PanelBroadcaster;
	link: ContentLink;
	transport: ScriptedEngineTransport;
	controller: EngineController;
	keepalive: Keepalive;
	timingLog: TimingLogWriter;
	debuggerManager: DebuggerManager;
	spoken: string[];
	toasts: Array<Extract<PanelPortMessage, { kind: "toast" }>>;
	session(): GameSession;
	executor(): MoveExecutor | null;
	settings(): Settings;
	patch(patch: SettingsPatch): Promise<void>;
	snapshot(): Promise<PanelSnapshot>;
	/** Commands the service worker sent down the game port. */
	commands(): GamePortCommand[];
	/**
	 * Drive the page inside the service-worker context. The simulator picks the `chrome` a
	 * callback sees from the *active* context, and a promise continuation started by a port
	 * message (`executor.arm()` → `chrome.debugger.attach`) resolves after the poster's own
	 * activation is gone — so everything the page pushes at the worker is pushed from inside it.
	 */
	drive<T>(fn: () => T): Promise<T>;
	/** `site.arrive` from inside the service-worker context. */
	arrive(opponentUci?: string | null, clocks?: { w: number; b: number }): Promise<void>;
	/**
	 * A trusted `keydown` on the page. The event is dispatched in the *content* context (Chrome
	 * never delivers a `runtime.sendMessage` back to its own sender), then the worker's context
	 * is made active so the handler's continuation sees the extension `chrome`.
	 */
	pressKey(bind: { key: string; code: string; shiftKey?: boolean }): Promise<void>;
	/** Advance the virtual clock inside the service-worker context. */
	advance(ms: number): Promise<void>;
	/**
	 * Step the clock until `predicate` holds (or the budget runs out); resolves `true` on
	 * success. The first step always runs, so a predicate that is already true for the *previous*
	 * state (a port message still in flight) cannot short-circuit the wait.
	 */
	until(predicate: () => boolean, budgetMs?: number, stepMs?: number): Promise<boolean>;
	dispose(): Promise<void>;
}

const DEFAULT_TC = { baseMs: 300_000, incMs: 2_000 };

export async function createGameHarness(options: GameHarnessOptions = {}): Promise<GameHarness> {
	// §4.4: every session path is gated on the switch, so the fixture states it — a user with the
	// assistant on — rather than inheriting `DEFAULT_SETTINGS` and silently changing meaning when
	// that default moves. Seeded as *stored* settings so no settings-write event fires before the
	// stack is up. A test about the switch itself passes `settings: { enabled: false }`, which wins
	// below.
	const sim = createSimulator({
		startAt: START_AT,
		storageLocal: { [LOCAL_KEYS.settings]: { enabled: true }, ...options.storage },
	});
	sim.time.install();
	const tabId = sim.openTab("https://www.chess.com/game/live/1", { active: true }).tabId;
	const timeControl = options.timeControl === undefined ? DEFAULT_TC : options.timeControl;
	const spoken: string[] = [];
	const toasts: Array<Extract<PanelPortMessage, { kind: "toast" }>> = [];

	let settings: Settings = DEFAULT_SETTINGS;
	let keepalive!: Keepalive;
	let debuggerManager!: DebuggerManager;
	let link!: ContentLink;
	let focus!: FocusGate;
	let ownership!: HandOwnership;
	let transport!: ScriptedEngineTransport;
	let engine!: UciEngine;
	let controller!: EngineController;
	let registry!: SessionRegistry;
	let broadcaster!: PanelBroadcaster;
	let router!: MessageRouter;
	let timingLog!: TimingLogWriter;
	let offSettings: () => void = () => {};
	let offCommands: () => void = () => {};

	const sw = await bootSwContext(sim, {
		entry: async () => {
			settings = await getSettings();
			offSettings = onSettingsChanged((next) => {
				settings = next;
				// The same reaction `createGameStack` installs (content re-push + the Task 13
				// `pendingOptions` stop) — one implementation, driven from both places.
				registry.settingsChanged();
			});
			keepalive = new Keepalive();
			debuggerManager = new DebuggerManager({
				keepalive,
				scheduler: defaultScheduler,
				now: sim.now,
			});
			await debuggerManager.ready;
			link = new ContentLink({ scheduler: defaultScheduler, now: sim.now });
			focus = new FocusGate(link, { now: sim.now });
			ownership = new HandOwnership(link, { now: sim.now });
			timingLog = new TimingLogWriter();
			transport = new ScriptedEngineTransport(options.script ?? {});
			engine = new UciEngine(transport);
			controller = new EngineController(engine, {
				getSettings,
				onSettingsChanged,
				env: { hardwareConcurrency: 4, sab: true },
				cache: new AnalysisCache(),
				now: sim.now,
			});
			await engine.init();
			router = installMessageRouter();
			registry = new SessionRegistry({
				link,
				engine: controller,
				book: null,
				head: options.head ?? new V1ParametricHead(),
				debugger: debuggerManager,
				focus,
				ownership,
				keepalive,
				timingLog,
				getSettings: () => settings,
				notify: () => broadcaster.notify(),
				speak: async (text) => {
					spoken.push(text);
					await sim.chrome.tts.speak(text, {}, () => {});
				},
				license: () => LICENSE,
				engineStatus: () => undefined,
				activeTabId: () => Promise.resolve(tabId),
				engineHasPendingOptions: () => controller.status().pendingOptions,
				observeExecutor: (id, executor) => broadcaster.observeExecutor(id, executor),
				now: sim.now,
				scheduler: defaultScheduler,
				seed: options.seed ?? "harness",
			});
			broadcaster = new PanelBroadcaster(registry, { scheduler: defaultScheduler, now: sim.now });
			// Task 28's port toasts, recorded for `h.toasts`. The harness connects no panel port, so
			// wrapping the broadcaster's own method is the only place they are observable — and a
			// "Played …" toast for a move that was not played is exactly what Fix F must not produce.
			const postToast = broadcaster.toast.bind(broadcaster);
			broadcaster.toast = (level, toast, tabId) => {
				toasts.push({ kind: "toast", level, ...toast });
				return postToast(level, toast, tabId);
			};
			registerPanelHandlers(router, {
				broadcaster,
				sources: registry,
				link,
				getSettings: () => settings,
			});
			registerContentHandlers(router, {
				getSettings: () => settings,
				session: (id) => registry.sessionFor(id),
				ensure: (id) => void registry.ensure(id),
			});
			// The `chrome.commands` bridge `wireServiceLifecycle` installs (Task 9 / §13.4: a
			// browser-level shortcut, so the page never loses focus).
			offCommands = onCommand((command) => {
				void Promise.resolve(registry.forActiveTab()).then((session) => session?.onCommand(command));
			});
			router.install();
		},
	});

	// Settings live in *this* simulator's storage, so they are written inside the SW context.
	if (options.settings) {
		await sw.run(async () => {
			settings = await setSettings(options.settings ?? {});
		});
	}

	const page = await createSimulatedSite(sim, tabId, {
		myColor: options.myColor ?? "w",
		gameId: options.gameId ?? "harness-game",
		timeControl,
		...(options.fen ? { fen: options.fen } : {}),
		...(options.sendKeybinds ? { sendKeybinds: true } : {}),
		...(options.premoves ? { premoves: true } : {}),
	});
	await sim.time.runMicrotasks();

	const advance = (ms: number): Promise<void> => sw.run(() => sim.time.advance(ms));
	const until = async (
		predicate: () => boolean,
		budgetMs = 30_000,
		stepMs = 10
	): Promise<boolean> => {
		const giveUp = sim.now() + budgetMs;
		await advance(0); // let anything already posted reach its listener first
		while (!predicate() && sim.now() < giveUp) await advance(stepMs);
		return predicate();
	};

	const harness: GameHarness = {
		sim,
		sw,
		site: page,
		tabId,
		router,
		registry,
		broadcaster,
		link,
		transport,
		controller,
		keepalive,
		timingLog,
		debuggerManager,
		spoken,
		toasts,
		session: () => {
			const s = registry.sessionFor(tabId);
			if (!s) throw new Error("harness: no session on the tab");
			return s;
		},
		executor: () => registry.sessionFor(tabId)?.executor() ?? null,
		settings: () => settings,
		async patch(patch) {
			// The drain happens *inside* the worker context, like `drive`: a settings write fans out
			// synchronously (`registry.settingsChanged`) and what it starts — an executor abort
			// winding down through the hand's release, say — continues in microtasks that must still
			// see the worker's `chrome`. Draining them outside the activation would fail every
			// `chrome.debugger` call and fake a bug the browser does not have.
			await sw.run(async () => {
				settings = await setSettings(patch);
				await sim.time.runMicrotasks();
			});
			await sim.time.runMicrotasks();
		},
		// Built inside the service-worker context: the broadcaster resolves the game tab through
		// `chrome.tabs.query`, which must be *this* simulator's.
		snapshot: () => sw.run(() => broadcaster.snapshotFor(null)),
		commands: () => page.commands(),
		async drive(fn) {
			const value = await sw.run(async () => {
				const out = fn();
				await sim.time.runMicrotasks();
				return out;
			});
			await sim.time.runMicrotasks();
			return value;
		},
		async arrive(opponentUci = null, clocks = clocksOf(timeControl?.baseMs ?? DEFAULT_TC.baseMs)) {
			await harness.drive(() => page.arrive(opponentUci, clocks));
		},
		async pressKey(bind) {
			// Nested activations: the dispatch happens with the content script's `chrome`
			// installed, everything after it with the worker's — which is what the handler's
			// own continuations (`executor.arm()` → `chrome.debugger.attach`) need.
			await sw.run(async () => {
				// The dispatch itself is synchronous, so the content globals are installed and
				// restored without ever yielding: everything the handler queues afterwards drains
				// with the worker's `chrome` installed.
				const restore = page.content.activate();
				try {
					page.pressKey(bind);
				} finally {
					restore();
				}
				await sim.time.runMicrotasks();
			});
			await sim.time.runMicrotasks();
		},
		advance,
		until,
		async dispose() {
			await sw.run(() => {
				broadcaster.dispose();
				registry.dispose();
				timingLog.dispose();
				focus.dispose();
				ownership.dispose();
				link.dispose();
				debuggerManager.dispose();
				controller.dispose();
				void engine.dispose();
				router.dispose();
				offCommands();
				offSettings();
			});
			await page.dispose();
			await sw.teardown();
			sim.time.uninstall();
			await sim.dispose();
		},
	};

	if (!options.manualStart) {
		await harness.drive(() => {
			page.hello();
			page.startGame();
		});
	}
	return harness;
}

/** The clocks every `arrive()` reports (a comfortable rapid game). */
export function clocksOf(base = DEFAULT_TC.baseMs): { w: number; b: number } {
	return { w: base, b: base };
}
