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

import { onTabRemoved, onTabUpdated } from "@core/chrome/tabs";
import { KEEPALIVE_REASONS } from "@core/constants/alarms";
import { log } from "@core/logger";
import type { TimeControlClass } from "@core/motor/types";
import { createRng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import type { TimingLogWriter } from "@core/timing/timing-log";
import type { DistributionHead } from "@core/timing/types";
import { errorMessage } from "@core/util/errors";
import { defaultNow, defaultScheduler, type Scheduler } from "@core/util/scheduler";
import { AutoQueue } from "@service/auto-queue";
import type { GameSessionHandle, GameSessionRegistry } from "@service/bootstrap";
import type { ContentLink } from "@service/content-link";
import type { DebuggerManager } from "@service/debugger-manager";
import type { EngineController } from "@service/engine-controller";
import type { FocusGate } from "@service/focus-gate";
import type { HandOwnership } from "@service/hand-ownership";
import type { Keepalive } from "@service/keepalive";
import { MoveExecutor } from "@service/move-executor";
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
	keepalive: Keepalive;
	timingLog: TimingLogWriter;
	/** The latest settings; the service worker keeps it fresh from storage. */
	getSettings(): Settings;
	notify(): void;
	speak(text: string): Promise<void>;
	license(): LicenseState;
	engineStatus(): EngineStatus | undefined;
	/** Resolves the tab a `chrome.commands` shortcut is aimed at. */
	activeTabId(): Promise<number | null>;
	/** Task 34: warm the ChessMimic band for a target Elo. */
	warmTiming?: ((targetElo: number) => void) | undefined;
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
	private disposed = false;
	private holdingKeepalive = false;

	constructor(deps: SessionRegistryDeps) {
		this.deps = deps;
		this.now = deps.now ?? defaultNow;
		this.scheduler = deps.scheduler ?? defaultScheduler;
		this.hand = { debugger: deps.debugger, focus: deps.focus, ownership: deps.ownership };
		this.autoQueue = new AutoQueue({
			link: deps.link,
			scheduler: this.scheduler,
			rng: createRng(`${deps.seed ?? "sl"}:auto-queue`),
		});
		this.offs.push(
			deps.link.onConnect((tabId) => void this.ensure(tabId)),
			deps.link.onDisconnect((tabId) => this.drop(tabId, "disconnected")),
			onTabRemoved((tabId) => {
				this.sessions.get(tabId)?.session.onTabEvent("tabRemoved");
				this.drop(tabId, "tab removed");
			}),
			onTabUpdated((tabId, changeInfo) => {
				if (typeof changeInfo.url === "string")
					this.sessions.get(tabId)?.session.onTabEvent("navigated");
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
		for (const tabId of [...this.sessions.keys()]) this.drop(tabId, "disposed");
		this.autoQueue.dispose();
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
			now: this.now,
			scheduler: this.scheduler,
			persona: config.persona,
			tcClass: config.tcClass,
			style: settings.execution.style,
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

	private drop(tabId: number, reason: string): void {
		const entry = this.sessions.get(tabId);
		if (!entry) return;
		this.sessions.delete(tabId);
		entry.detachObserver?.();
		for (const off of entry.offs.splice(0)) off();
		entry.session.dispose();
		this.autoQueue.cancel(tabId);
		log.debug("session-registry: session closed", { tabId, reason });
		this.reconcileKeepalive();
		this.deps.notify();
	}

	/** `Keepalive.hold("game")` while any tab is live (§3.3 / Appendix B §4). */
	private reconcileKeepalive(): void {
		const live = [...this.sessions.values()].some((e) => e.session.isLive());
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
