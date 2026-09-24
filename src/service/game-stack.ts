/**
 * Construction of the service worker's game stack (Task 30): the pieces that
 * exist once per worker and that every tab's `GameSession` shares — the engine
 * (`UciEngine` over `RemoteEngine` over the offscreen document), its controller
 * and analysis cache, the opening book, the ChessMimic timing head with its v1
 * fallback, the Maia-3 policy port (2026-09-11), the hand stack (debugger /
 * content link / focus gate / hand ownership), the timing log and the session
 * registry.
 *
 * Kept out of `service-worker.ts` so the entry point stays a listener list and
 * the whole stack can be built in a test against the simulator. The parts are built in
 * `game-stack/`: `engine-stack.ts`, `hand-stack.ts`, `settings-snapshot.ts` and
 * `policy-warmup.ts`.
 */

import { tabsQuery } from "@core/chrome/tabs";
import type { OptionsEnv } from "@core/engine/options";
import type { RemoteEngine } from "@core/engine/remote-engine";
import type { UciEngine } from "@core/engine/uci-client";
import { log } from "@core/logger";
import type { MessageRouter } from "@core/messaging/router";
import { getSettings, onSettingsChanged } from "@core/storage/settings-storage";
import { createBookPolicy } from "@core/strength/book/book-policy";
import { TablebaseClient } from "@core/tablebase/client";
import { ChessMimicHead, selectBand } from "@core/timing/chessmimic-head";
import { TimingLogWriter } from "@core/timing/timing-log";
import { V1ParametricHead } from "@core/timing/v1-head";
import { errorMessage } from "@core/util/errors";
import type { ServiceSystems } from "@service/bootstrap";
import type { ContentLink } from "@service/content-link";
import type { EngineController } from "@service/engine-controller";
import { SessionRegistry } from "@service/game-session";
import { createEngineStack, defaultEnv } from "@service/game-stack/engine-stack";
import { createHandStack } from "@service/game-stack/hand-stack";
import { policyWarmup } from "@service/game-stack/policy-warmup";
import { SettingsSnapshot } from "@service/game-stack/settings-snapshot";
import { registerContentHandlers } from "@service/handlers/content";
import { registerEngineHandlers } from "@service/handlers/engine";
import { createPolicyInferPort } from "@service/handlers/engine/policy-infer";
import { createTimingInferPort } from "@service/handlers/engine/timing-infer";
import type { PanelBroadcaster } from "@service/panel-broadcaster";
import type { ReviewEngine } from "@service/review-engine";
import { speak } from "@service/tts";
import type { Settings } from "@typedefs/settings";

export interface GameStack {
	link: ContentLink;
	engine: UciEngine;
	transport: RemoteEngine;
	controller: EngineController;
	reviewEngine: ReviewEngine;
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

/** The active tab of the last-focused window, or `null` when there is none or the query failed. */
async function activeTabId(): Promise<number | null> {
	try {
		const tabs = await tabsQuery({ active: true, lastFocusedWindow: true });
		const id = tabs[0]?.id;
		return typeof id === "number" ? id : null;
	} catch (error) {
		log.debug("game-stack: active tab query failed", { error: errorMessage(error) });
		return null;
	}
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
	const settings = new SettingsSnapshot();

	const { transport, engine, reviewEngine, controller } = createEngineStack(
		options.env ?? defaultEnv()
	);
	const { link, debuggerManager, focus, ownership, board } = createHandStack(systems.keepalive);
	const timingLog = new TimingLogWriter(undefined, (entry) => broadcaster.timingEntry(entry));

	const inferPort = createTimingInferPort(transport);
	const policyPort = createPolicyInferPort(transport);

	const book = createBookPolicy();
	// 2026-09-23: ≤ 7-man positions from the Lichess tablebase API, fetched by this worker only.
	const tablebase = new TablebaseClient();

	const synchronizePolicyWarmup = policyWarmup({
		liveTargets: () =>
			registry
				.all()
				.filter((session) => session.isLive())
				.map((session) => session.targetElo()),
		enabled: () => settings.get().enabled,
		transport,
		policy: policyPort,
	});

	const registry: SessionRegistry = new SessionRegistry({
		link,
		engine: controller,
		review: reviewEngine,
		book,
		tablebase,
		createHead: () =>
			new ChessMimicHead({ infer: inferPort.infer, fallback: new V1ParametricHead() }),
		debugger: debuggerManager,
		focus,
		ownership,
		board,
		keepalive: systems.keepalive,
		timingLog,
		getSettings: settings.get,
		settingsKnown: settings.known,
		notify: () => broadcaster.notify(),
		speak,
		license: () => systems.license.getState(),
		engineStatus: () => transport.status(),
		activeTabId,
		warmTiming: (targetElo) => inferPort.warm(selectBand(targetElo)),
		policy: policyPort,
		warmPolicy: (targetElo) => synchronizePolicyWarmup(targetElo),
		engineHasPendingOptions: () => controller.status().pendingOptions,
		observeExecutor: (tabId, executor) => broadcaster.observeExecutor(tabId, executor),
	});

	registerContentHandlers(router, {
		getSettings: settings.get,
		session: (tabId) => registry.sessionFor(tabId),
		ensure: (tabId) => void registry.ensure(tabId),
	});
	const detachEngineHandlers = registerEngineHandlers(router, transport);

	// Settings: one snapshot everything reads, refreshed on every write. A change that leaves the
	// engine with `pendingOptions` must not be starved by a running ponder (Task 13), so every
	// session's `go infinite` is stopped when one is waiting.
	const applySettings = (next: Settings): void => {
		settings.update(next);
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
		// Only ratings use the review engine; board effects are pure chess (owner, 2026-09-15: the
		// two switches are independent), so the rays alone never keep it booted.
		if (!next.enabled || !next.automation.moveQualityChips) reviewEngine.release();
		const active = registry.all().find((session) => session.isLive());
		synchronizePolicyWarmup(active?.targetElo() ?? settings.get().strength.targetElo);
	};
	const offSettings = onSettingsChanged(applySettings);
	void getSettings().then(applySettings, (error: unknown) =>
		log.warn("game-stack: initial settings read failed", error)
	);
	void timingLog
		.load()
		.catch((error: unknown) => log.warn("game-stack: timing log not loaded", error));
	void controller
		.init()
		.catch((error: unknown) => log.warn("game-stack: engine init deferred", errorMessage(error)));

	return {
		link,
		engine,
		transport,
		controller,
		reviewEngine,
		registry,
		timingLog,
		getSettings: settings.get,
		settingsKnown: settings.known,
		dispose(): void {
			offSettings();
			detachEngineHandlers();
			registry.dispose();
			reviewEngine.dispose();
			board.dispose();
			void timingLog
				.flush()
				.catch(() => {})
				.finally(() => timingLog.dispose());
			inferPort.dispose();
			policyPort.dispose();
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
