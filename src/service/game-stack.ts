/**
 * Construction of the service worker's game stack (Task 30): the pieces that
 * exist once per worker and that every tab's `GameSession` shares — the engine
 * (`UciEngine` over `RemoteEngine` over the offscreen document), its controller
 * and analysis cache, the opening book, the ChessMimic timing head with its v1
 * fallback, the hand stack (debugger / content link / focus gate / hand
 * ownership), the timing log and the session registry.
 *
 * Kept out of `service-worker.ts` so the entry point stays a listener list and
 * the whole stack can be built in a test against the simulator.
 */

import { tabsQuery } from "@core/chrome/tabs";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { AnalysisCache } from "@core/engine/analysis-cache";
import type { OptionsEnv } from "@core/engine/options";
import { RemoteEngine } from "@core/engine/remote-engine";
import { UciEngine } from "@core/engine/uci-client";
import { log } from "@core/logger";
import type { MessageRouter } from "@core/messaging/router";
import { getSettings, onSettingsChanged } from "@core/storage/settings-storage";
import { createBookPolicy } from "@core/strength/book/book-policy";
import { ChessMimicHead, selectBand } from "@core/timing/chessmimic-head";
import { TimingLogWriter } from "@core/timing/timing-log";
import { V1ParametricHead } from "@core/timing/v1-head";
import { errorMessage } from "@core/util/errors";
import { BoardWatch } from "@service/board-watch";
import type { ServiceSystems } from "@service/bootstrap";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { EngineController } from "@service/engine-controller";
import { FocusGate } from "@service/focus-gate";
import { SessionRegistry } from "@service/game-session";
import { HandOwnership } from "@service/hand-ownership";
import { registerContentHandlers } from "@service/handlers/content";
import { registerEngineHandlers } from "@service/handlers/engine";
import { createTimingInferPort } from "@service/handlers/engine/timing-infer";
import { ensureOffscreen } from "@service/offscreen-manager";
import type { PanelBroadcaster } from "@service/panel-broadcaster";
import { speak } from "@service/tts";
import type { Settings } from "@typedefs/settings";

export interface GameStack {
	link: ContentLink;
	engine: UciEngine;
	transport: RemoteEngine;
	controller: EngineController;
	registry: SessionRegistry;
	timingLog: TimingLogWriter;
	/** The worker's one fresh `Settings` snapshot (what every consumer here reads). */
	getSettings(): Settings;
	/**
	 * Whether that snapshot is the stored settings yet, rather than `DEFAULT_SETTINGS` standing in
	 * until the first read answers (§4.4): every path that acts on the page holds while it is false.
	 */
	settingsKnown(): boolean;
	dispose(): void;
}

export interface GameStackOptions {
	systems: ServiceSystems;
	router: MessageRouter;
	broadcaster: PanelBroadcaster;
	/** Overridden in tests; production reads `navigator`. */
	env?: OptionsEnv;
}

function defaultEnv(): OptionsEnv {
	const concurrency =
		typeof navigator === "object" && typeof navigator.hardwareConcurrency === "number"
			? navigator.hardwareConcurrency
			: 1;
	return { hardwareConcurrency: concurrency, sab: typeof SharedArrayBuffer === "function" };
}

/**
 * Build and wire the whole per-worker game stack. Nothing here awaits: the
 * MV3 rule is that every listener is registered on the first turn, so the
 * asynchronous work (settings read, engine handshake, timing-log load) runs in
 * the background and the stack is usable — degraded — before it finishes.
 */
export function createGameStack(options: GameStackOptions): GameStack {
	const { systems, router, broadcaster } = options;
	// Settings are read once and kept fresh; every consumer takes the snapshot synchronously.
	// `settingsRead` is the part that matters for §4.4: until the first `chrome.storage.local` read
	// answers, `settings` is a placeholder and nothing may act on it in either direction.
	let settings: Settings = DEFAULT_SETTINGS;
	let settingsRead = false;
	const readSettings = (): Settings => settings;
	const settingsKnown = (): boolean => settingsRead;

	const transport = new RemoteEngine({
		ensureHost: ensureOffscreen,
		// §8.4b item 6 / Task 34: the ChessMimic head is the shipped timing head (V2.5), so the
		// offscreen document is asked to pre-load its default band with the first `configure`.
		// `setWarmTiming` after that first `configure` has no effect until a reconnect.
		warmTiming: true,
	});
	const engine = new UciEngine(transport);
	const cache = new AnalysisCache();
	const controller = new EngineController(engine, {
		getSettings,
		onSettingsChanged,
		env: options.env ?? defaultEnv(),
		cache,
	});

	const link = new ContentLink();
	const debuggerManager = new DebuggerManager({ keepalive: systems.keepalive });
	const focus = new FocusGate(link);
	const ownership = new HandOwnership(link);
	// §9.5: the board's viewport rect per tab, as the content script reports it.
	const board = new BoardWatch(link);
	const timingLog = new TimingLogWriter();

	const inferPort = createTimingInferPort(transport);
	const head = new ChessMimicHead({ infer: inferPort.infer, fallback: new V1ParametricHead() });

	const book = createBookPolicy();

	const registry = new SessionRegistry({
		link,
		engine: controller,
		book,
		head,
		debugger: debuggerManager,
		focus,
		ownership,
		board,
		keepalive: systems.keepalive,
		timingLog,
		getSettings: readSettings,
		settingsKnown,
		notify: () => broadcaster.notify(),
		speak,
		license: () => systems.license.getState(),
		engineStatus: () => transport.status(),
		activeTabId: async () => {
			try {
				const tabs = await tabsQuery({ active: true, lastFocusedWindow: true });
				const id = tabs[0]?.id;
				return typeof id === "number" ? id : null;
			} catch (error) {
				log.debug("game-stack: active tab query failed", { error: errorMessage(error) });
				return null;
			}
		},
		warmTiming: (targetElo) => inferPort.warm(selectBand(targetElo)),
		engineHasPendingOptions: () => controller.status().pendingOptions,
		observeExecutor: (tabId, executor) => broadcaster.observeExecutor(tabId, executor),
	});

	registerContentHandlers(router, {
		getSettings: readSettings,
		session: (tabId) => registry.sessionFor(tabId),
		ensure: (tabId) => void registry.ensure(tabId),
	});
	const detachEngineHandlers = registerEngineHandlers(router, transport);

	// Settings: one snapshot everything reads, refreshed on every write. A change that leaves the
	// engine with `pendingOptions` must not be starved by a running ponder (Task 13), so every
	// session's `go infinite` is stopped when one is waiting.
	const applySettings = (next: Settings): void => {
		settings = next;
		settingsRead = true;
		// The registry owns the whole reaction (content re-push + the `pendingOptions` stop), so
		// this path and any harness driving the registry directly cannot drift apart.
		//
		// The *first* read fans out too, even though it is not a write: on a cold MV3 wake the
		// queued port connect — and the first `position` behind it — can beat this read, so a
		// `GameSession` can be built, and a ply arrive, before `settings` is the user's. That ply
		// is *held* (`settingsKnown()` is false until the line above), and nothing re-delivers it:
		// the content script's replay is swallowed by the feed dedupe. Fanning out is what releases
		// it — `resumeEnabled` picks the held position up with the settings that really apply.
		registry.settingsChanged();
	};
	const offSettings = onSettingsChanged(applySettings);
	void getSettings().then(applySettings, (error: unknown) =>
		log.warn("game-stack: initial settings read failed", error)
	);
	void timingLog
		.load()
		.catch((error: unknown) => log.warn("game-stack: timing log not loaded", error));
	void engine
		.init()
		.catch((error: unknown) => log.warn("game-stack: engine init deferred", errorMessage(error)));

	return {
		link,
		engine,
		transport,
		controller,
		registry,
		timingLog,
		getSettings: readSettings,
		settingsKnown,
		dispose(): void {
			offSettings();
			detachEngineHandlers();
			registry.dispose();
			board.dispose();
			void timingLog.flush().catch(() => {});
			timingLog.dispose();
			inferPort.dispose();
			book.dispose();
			focus.dispose();
			ownership.dispose();
			debuggerManager.dispose();
			link.dispose();
			controller.dispose();
			void engine.dispose();
			transport.dispose();
		},
	};
}
