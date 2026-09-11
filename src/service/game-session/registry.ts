/**
 * `GameSessionRegistry` (§3.3): one `GameSession` per tab, created when that
 * tab's content script says `hello` on a supported page and dropped when the
 * port goes away, the tab is removed or the tab navigates. It also owns the
 * per-service-worker singletons the sessions share — the engine controller and
 * its ponder budget, the opening book, the timing head, the hand stack, the
 * timing-log writer, the auto-queue — and implements the panel broadcaster's
 * `SnapshotSources`, so the panel reads real sessions instead of the idle
 * placeholder.
 *
 * `Keepalive.hold("game")` is held here rather than per session: it is one
 * alarm for the whole worker, held while *any* tab is live.
 */

import { pageKindFromPath } from "@content/adapters/page-kind";
import { onTabRemoved, onTabUpdated, tabsQuery } from "@core/chrome/tabs";
import { KEEPALIVE_REASONS } from "@core/constants/alarms";
import { URLS } from "@core/constants/urls";
import { log } from "@core/logger";
import type { TimeControlClass } from "@core/motor/types";
import { createRng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import type { TimingLogWriter } from "@core/timing/timing-log";
import type { DistributionHead } from "@core/timing/types";
import { errorMessage } from "@core/util/errors";
import { defaultNow, defaultScheduler, type Scheduler } from "@core/util/scheduler";
import { AutoQueue } from "@service/auto-queue";
import { createAutoQueuePersistence } from "@service/auto-queue-persistence";
import type { BoardRectSource } from "@service/board-watch";
import type { GameSessionHandle, GameSessionRegistry } from "@service/bootstrap";
import type { ContentLink } from "@service/content-link";
import type { DebuggerManager } from "@service/debugger-manager";
import type { EngineController } from "@service/engine-controller";
import type { FocusGate } from "@service/focus-gate";
import type { HandOwnership } from "@service/hand-ownership";
import type { Keepalive } from "@service/keepalive";
import { MoveExecutor } from "@service/move-executor";
import { NewGameInput } from "@service/new-game-input";
import type {
	ExecutorHandle,
	HandSources,
	SessionSource,
	SnapshotSources,
} from "@service/panel-broadcaster";
import type { EngineStatus } from "@typedefs/engine";
import type { Site } from "@typedefs/game";
import type { LicenseState, PersonaId, Settings } from "@typedefs/settings";
import { GameSession } from "./session";

export interface SessionRegistryDeps {
	link: ContentLink;
	engine: EngineController | null;
	book: BookPolicy | null;
	head: DistributionHead;
	debugger: DebuggerManager;
	focus: FocusGate;
	ownership: HandOwnership;
	/** §9.5: the board's last reported rect per tab (the hand's reflow guard and the settle wait). */
	board?: BoardRectSource | undefined;
	keepalive: Keepalive;
	timingLog: TimingLogWriter;
	/** The latest settings; the service worker keeps it fresh from storage. */
	getSettings(): Settings;
	/**
	 * Whether `getSettings()` is the stored settings yet (§4.4 / the MV3 cold start): a session
	 * built before the first `chrome.storage.local` read answers must hold rather than act on
	 * `DEFAULT_SETTINGS`. Omitted by a caller whose settings are already real.
	 */
	settingsKnown?: (() => boolean) | undefined;
	notify(): void;
	speak(text: string): Promise<void>;
	license(): LicenseState;
	engineStatus(): EngineStatus | undefined;
	/** Resolves the tab a `chrome.commands` shortcut is aimed at. */
	activeTabId(): Promise<number | null>;
	/** Task 34: warm the ChessMimic band for a target Elo. */
	warmTiming?: ((targetElo: number) => void) | undefined;
	/**
	 * Task 13: `EngineController.status().pendingOptions` — a settings change waiting for the
	 * engine to go idle. The registry owns the whole reaction to a settings write so the service
	 * worker and any harness take the same path.
	 */
	engineHasPendingOptions?: (() => boolean) | undefined;
	/** Called with each new executor so the broadcaster can surface its results. */
	observeExecutor?: ((tabId: number, executor: MoveExecutor) => () => void) | undefined;
	now?: () => number;
	scheduler?: Scheduler;
	seed?: string;
}

interface Entry {
	session: GameSession;
	offs: Array<() => void>;
	/** The executor the broadcaster is currently observing. */
	observed: MoveExecutor | null;
	detachObserver: (() => void) | null;
}

export class SessionRegistry implements GameSessionRegistry, SnapshotSources {
	readonly hand: HandSources;
	private readonly deps: SessionRegistryDeps;
	private readonly now: () => number;
	private readonly scheduler: Scheduler;
	private readonly sessions = new Map<number, Entry>();
	private readonly offs: Array<() => void> = [];
	private readonly autoQueue: AutoQueue;
	private readonly newGameInput: NewGameInput;
	private disposed = false;
	private holdingKeepalive = false;

	constructor(deps: SessionRegistryDeps) {
		this.deps = deps;
		this.now = deps.now ?? defaultNow;
		this.scheduler = deps.scheduler ?? defaultScheduler;
		this.hand = { debugger: deps.debugger, focus: deps.focus, ownership: deps.ownership };
		// New worker lifetimes must not replay identical session lengths and button paths.
		// Tests can inject a fixed seed; sampled session/break deadlines are persisted separately.
		const queueSeed = deps.seed ?? crypto.randomUUID();
		this.newGameInput = new NewGameInput({
			link: deps.link,
			debugger: deps.debugger,
			ownership: deps.ownership,
			focus: deps.focus,
			rng: createRng(`${queueSeed}:queue-input`),
			scheduler: this.scheduler,
			now: this.now,
			showCursor: () => deps.getSettings().display.virtualCursor,
		});
		this.autoQueue = new AutoQueue({
			attempt: async (tabId, gameId, signal) => {
				await this.sessions.get(tabId)?.session.executor()?.whenIdle();
				return this.newGameInput.attempt(tabId, gameId, signal);
			},
			scheduler: this.scheduler,
			now: this.now,
			rng: createRng(`${queueSeed}:auto-queue`),
			persistence: createAutoQueuePersistence(),
			canQueue: (tabId, gameId) => {
				if (deps.settingsKnown?.() === false) return "hold";
				const settings = deps.getSettings();
				if (!settings.enabled || !settings.automation.autoQueue) return "cancel";
				const session = this.sessions.get(tabId)?.session;
				if (!session) return "hold";
				const view = session.view();
				if (view.gameId !== null && view.gameId !== gameId) return "cancel";
				return view.state === "game-over" || view.state === "waiting-for-game" ? "allow" : "hold";
			},
			onChanged: () => {
				this.reconcileKeepalive();
				deps.notify();
			},
		});
		void this.autoQueue.ready
			.then(async () => {
				const restoredTabs = this.autoQueue.tabIds();
				if (restoredTabs.length === 0) return;
				const openTabs = new Set((await tabsQuery({})).map((tab) => tab.id));
				if (this.disposed) return;
				for (const tabId of restoredTabs)
					if (!openTabs.has(tabId) && !deps.link.isConnected(tabId)) this.autoQueue.cancel(tabId);
			})
			.catch((error: unknown) => log.warn("auto-queue: tab recovery check failed", error));
		// A port that connected before this registry existed (an SW that built its stack in an
		// unusual order) still gets a session.
		for (const tabId of deps.link.tabs()) this.ensure(tabId);
		this.offs.push(
			deps.link.onConnect((tabId) => void this.ensure(tabId)),
			deps.link.onDisconnect((tabId) => this.drop(tabId, "disconnected", true)),
			onTabRemoved((tabId) => {
				this.sessions.get(tabId)?.session.onTabEvent("tabRemoved");
				this.drop(tabId, "tab removed");
				this.autoQueue.cancel(tabId);
			}),
			onTabUpdated((tabId, changeInfo) => {
				if (typeof changeInfo.url !== "string") return;
				let queuePage = false;
				try {
					const url = new URL(changeInfo.url);
					const kind = pageKindFromPath(url.pathname);
					queuePage =
						url.origin === new URL(URLS.chesscom).origin &&
						(kind === "live-game" || kind === "live-lobby" || kind === "vs-computer");
				} catch {
					/* An invalid destination cancels pending input. */
				}
				const preserve = queuePage && this.autoQueue.isTracking(tabId);
				this.sessions.get(tabId)?.session.onTabEvent("navigated", preserve);
				if (!queuePage) this.autoQueue.cancel(tabId);
			})
		);
	}

	// ── SnapshotSources ────────────────────────────────────────────────────

	session(tabId: number): SessionSource | null {
		return this.sessionFor(tabId);
	}

	/** The concrete session on `tabId` (the content handlers route keybinds through it). */
	sessionFor(tabId: number): GameSession | null {
		return this.sessions.get(tabId)?.session ?? null;
	}

	executor(tabId: number): ExecutorHandle | null {
		return this.sessions.get(tabId)?.session.executor() ?? null;
	}

	engineStatus(): EngineStatus | undefined {
		return this.deps.engineStatus();
	}

	license(): LicenseState {
		return this.deps.license();
	}

	// ── GameSessionRegistry ────────────────────────────────────────────────

	async forActiveTab(): Promise<GameSessionHandle | null> {
		const tabId = await this.deps.activeTabId();
		if (tabId === null) return null;
		return this.sessions.get(tabId)?.session ?? null;
	}

	/** Every open session (the service worker's settings watcher walks them). */
	all(): GameSession[] {
		return [...this.sessions.values()].map((e) => e.session);
	}

	/**
	 * Stop every running `go infinite` (Task 13): a ponder or panel search holds the
	 * engine busy, and `EngineController` only applies a pending options change while
	 * the engine is idle — so a settings write would otherwise never take effect.
	 */
	stopSearches(reason: string): void {
		log.debug("session-registry: stopping searches", { reason, sessions: this.sessions.size });
		for (const entry of this.sessions.values()) void entry.session.stopSearch();
	}

	/**
	 * A settings write. Every session re-sends what the content script acts on (§13.3 rule 4), and
	 * — when the write left the engine with a deferred options diff — every running `go infinite`
	 * is stopped: `EngineController` only applies a diff while the engine is idle, so a live
	 * ponder would hold it busy and the change would never land.
	 */
	settingsChanged(): void {
		for (const entry of this.sessions.values()) entry.session.onSettingsChanged();
		void this.autoQueue.wake();
		// `EngineController` marks the diff pending from its *own* settings subscriber, so whether
		// it has already run depends on registration order. Reading the flag one microtask later
		// makes the reaction order-independent: every subscriber of this write has run by then,
		// and a deferred diff stays pending until the engine goes idle.
		queueMicrotask(() => {
			if (this.disposed) return;
			if (this.deps.engineHasPendingOptions?.() === true) this.stopSearches("engine options pending");
		});
	}

	/** The session for `tabId`, created on demand (the content port is already up). */
	ensure(tabId: number): GameSession {
		const existing = this.sessions.get(tabId);
		if (existing) return existing.session;
		const entry: Entry = {
			session: this.build(tabId),
			offs: [],
			observed: null,
			detachObserver: null,
		};
		this.sessions.set(tabId, entry);
		log.debug("session-registry: session opened", { tabId });
		return entry.session;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const off of this.offs.splice(0)) off();
		for (const tabId of [...this.sessions.keys()]) this.drop(tabId, "disposed", true);
		this.autoQueue.dispose();
		this.newGameInput.dispose();
		void this.deps.keepalive.release(KEEPALIVE_REASONS.game);
	}

	// ── internals ──────────────────────────────────────────────────────────

	private build(tabId: number): GameSession {
		const session = new GameSession({
			tabId,
			link: this.deps.link,
			engine: this.deps.engine,
			book: this.deps.book,
			head: this.deps.head,
			debugger: this.deps.debugger,
			focus: this.deps.focus,
			ownership: this.deps.ownership,
			timingLog: this.deps.timingLog,
			autoQueue: this.autoQueue,
			createExecutor: (config) => this.makeExecutor(tabId, config),
			getSettings: this.deps.getSettings,
			settingsKnown: this.deps.settingsKnown,
			notify: this.deps.notify,
			speak: this.deps.speak,
			warmTiming: this.deps.warmTiming,
			onLivenessChanged: () => this.reconcileKeepalive(),
			now: this.now,
			scheduler: this.scheduler,
			seed: `${this.deps.seed ?? "sl"}:${tabId}`,
		});
		return session;
	}

	/** Alarm callbacks are registered at service-worker startup, before this promise is awaited. */
	wakeAutoQueue(): Promise<void> {
		return this.autoQueue.wake();
	}

	private makeExecutor(
		tabId: number,
		config: { site: Site; persona: PersonaId; tcClass: TimeControlClass; gameSeed: string }
	): MoveExecutor {
		const settings = this.deps.getSettings();
		const executor = new MoveExecutor({
			tabId,
			site: config.site,
			debugger: this.deps.debugger,
			link: this.deps.link,
			focus: this.deps.focus,
			ownership: this.deps.ownership,
			...(this.deps.board ? { board: this.deps.board } : {}),
			now: this.now,
			scheduler: this.scheduler,
			persona: config.persona,
			motorSpeed: settings.execution.motorSpeed,
			tcClass: config.tcClass,
			previewScale:
				settings.execution.previewSelects === "off" ? 0 : settings.execution.previewSelectScale,
			gameSeed: config.gameSeed,
			verifyMoves: settings.execution.verifyMoves,
		});
		const entry = this.sessions.get(tabId);
		if (entry) {
			entry.detachObserver?.();
			entry.observed = executor;
			entry.detachObserver = this.deps.observeExecutor?.(tabId, executor) ?? null;
		}
		return executor;
	}

	private drop(tabId: number, reason: string, preserveAutoQueue = false): void {
		const entry = this.sessions.get(tabId);
		if (!entry) return;
		this.sessions.delete(tabId);
		entry.detachObserver?.();
		for (const off of entry.offs.splice(0)) off();
		entry.session.dispose(preserveAutoQueue);
		if (!preserveAutoQueue) this.autoQueue.cancel(tabId);
		log.debug("session-registry: session closed", { tabId, reason });
		this.reconcileKeepalive();
		this.deps.notify();
	}

	/** `Keepalive.hold("game")` while any tab is live (§3.3 / Appendix B §4). */
	private reconcileKeepalive(): void {
		const live =
			this.autoQueue.hasPending() || [...this.sessions.values()].some((e) => e.session.isLive());
		if (live === this.holdingKeepalive) return;
		this.holdingKeepalive = live;
		const run = live
			? this.deps.keepalive.hold(KEEPALIVE_REASONS.game)
			: this.deps.keepalive.release(KEEPALIVE_REASONS.game);
		void run.catch((error: unknown) =>
			log.warn("session-registry: keepalive update failed", { error: errorMessage(error) })
		);
	}
}
