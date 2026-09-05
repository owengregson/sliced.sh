/**
 * Panel snapshot broadcaster (§4.3 `PanelPortMessage`, §10.4). Accepts every
 * `PORT_NAMES.panel` connection, builds the `PanelSnapshot` a panel should see
 * — the game session and hand of the active tab in the panel's window, the
 * engine status, settings, session stats and the license — and pushes it on
 * connect and whenever `notify()` is called, throttled to
 * `TIMINGS.panelSnapshotMinIntervalMs` with one trailing push so a burst ends
 * with the newest state. Ports are grouped by window so each window's panel
 * gets the snapshot of its own game tab. Settings, license and stats live in
 * `chrome.storage.local`; a change to any of them triggers a push on its own.
 *
 * `GameSessionRegistry` does not exist yet (Task 30 ruling): `SnapshotSources`
 * is the narrow read surface the broadcaster needs — Task 30's registry
 * implements `session(tabId)` / `executor(tabId)` and passes the shared
 * `DebuggerManager` / `FocusGate` / `HandOwnership` as `hand`. Until then the
 * service worker runs on `idleSnapshotSources()` (no game tab, no hand).
 *
 * `observeExecutor()` is how a tab's `MoveExecutor` reaches the panel: every
 * result is stamped with `at` (Task 24 keys the "played" toast on it), kept as
 * `session.lastExecution`, and an executed move / unverified move becomes a
 * `toast` port message; hand-state changes push a snapshot.
 */

import { chromeLocalGet, onStorageChanged } from "@core/chrome/storage";
import { tabsQuery } from "@core/chrome/tabs";
import { EXECUTOR } from "@core/constants/cdp";
import { DEFAULT_ENGINE_STATUS } from "@core/constants/defaults";
import type { PanelPortMessage, PanelSnapshot } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { type AcceptedPort, acceptPorts } from "@core/messaging/ports";
import { getSettings } from "@core/storage/settings-storage";
import { errorMessage } from "@core/util/errors";
import { defaultNow, defaultScheduler, type Scheduler } from "@core/util/scheduler";
import { COPY } from "@panel/copy";
import type { DebuggerManager } from "@service/debugger-manager";
import type { FocusGate } from "@service/focus-gate";
import type { HandOwnership } from "@service/hand-ownership";
import { EMPTY_SESSION_STATS } from "@service/handlers/log/session-reset";
import type { LicenseGate } from "@service/license-gate";
import type { ExecutionReport, MoveExecutor } from "@service/move-executor";
import type { EngineStatus } from "@typedefs/engine";
import type {
	ExecutionResult,
	GameSessionState,
	GameSessionView,
	Recommendation,
	SessionStats,
} from "@typedefs/game";
import type { LicenseState } from "@typedefs/settings";

// ── read interfaces (Task 30 implements) ────────────────────────────────

/** The game facts of a session; `hand` / `lastExecution` come from the executor. */
export type SessionGameView = Omit<GameSessionView, "hand" | "lastExecution">;
export type OpponentView = NonNullable<PanelSnapshot["opponent"]>;

/** What the broadcaster reads from one tab's `GameSession`. */
export interface SessionSource {
	view(): SessionGameView;
	/** The current position's recommendation (§3.2 step 4), if my turn has one. */
	recommendation(): Recommendation | null;
	/** V2 §13.6 opponent identity with the derived target, once the adapter reported it. */
	opponent(): OpponentView | null;
}

/** The per-tab executor surface the panel handlers and the broadcaster use. */
export type ExecutorHandle = Pick<
	MoveExecutor,
	| "isArmed"
	| "pendingMove"
	| "handView"
	| "on"
	| "arm"
	| "disarm"
	| "schedule"
	| "playNow"
	| "cancel"
>;

/** The shared hand stack (one per service worker; Task 18's singletons). */
export interface HandSources {
	debugger: Pick<DebuggerManager, "isAttached" | "lastError" | "ensureAttached" | "detach">;
	focus: Pick<FocusGate, "snapshot">;
	ownership: Pick<HandOwnership, "realPointerCount">;
}

export interface SnapshotSources {
	/** The game session on `tabId`, or `null` (idle snapshot). */
	session(tabId: number): SessionSource | null;
	/** The move executor on `tabId`, or `null` (no hand: unarmed, detached). */
	executor(tabId: number): ExecutorHandle | null;
	/** `null` until Task 30 constructs the hand stack. */
	hand: HandSources | null;
	/** Last status the offscreen host reported (`RemoteEngine.status()`); `undefined` before any. */
	engineStatus(): EngineStatus | undefined;
	license(): LicenseState;
}

/** Sources for a service worker without a session registry (every tab idle). */
export function idleSnapshotSources(license: Pick<LicenseGate, "getState">): SnapshotSources {
	return {
		session: () => null,
		executor: () => null,
		hand: null,
		engineStatus: () => undefined,
		license: () => license.getState(),
	};
}

// ── broadcaster ─────────────────────────────────────────────────────────

export interface PanelBroadcasterOptions {
	scheduler?: Scheduler;
	now?: () => number;
	/** Defaults to `TIMINGS.panelSnapshotMinIntervalMs`. */
	minIntervalMs?: number;
}

export type ToastLevel = Extract<PanelPortMessage, { kind: "toast" }>["level"];

interface Connection {
	port: AcceptedPort<PanelPortMessage, never>;
	/** The panel's window when the sender carries one; `null` → the last-focused window. */
	windowId: number | null;
}

/** Storage keys whose change alone warrants a fresh snapshot. */
const WATCHED_KEYS: readonly string[] = [
	LOCAL_KEYS.settings,
	LOCAL_KEYS.licenseState,
	LOCAL_KEYS.sessionStats,
];

const MS_PER_SECOND = 1000;

const IDLE_VIEW: Readonly<SessionGameView> = Object.freeze({
	state: "idle",
	gameId: null,
	site: null,
	pageKind: "other",
	myColor: null,
	sideToMove: null,
	ply: 0,
	clocks: null,
});

const isLive = (state: GameSessionState): boolean => state.startsWith("live:");

function windowIdOf(sender: chrome.runtime.MessageSender | undefined): number | null {
	const id = sender?.tab?.windowId;
	return typeof id === "number" ? id : null;
}

/** The active tab of `windowId` (or of the last-focused window) — the tab a panel shows. */
async function activeTabId(windowId: number | null): Promise<number | null> {
	try {
		const tabs = await tabsQuery(
			windowId === null ? { active: true, lastFocusedWindow: true } : { active: true, windowId }
		);
		const id = tabs[0]?.id;
		return typeof id === "number" ? id : null;
	} catch (error) {
		log.debug("panel-broadcaster: tabs.query failed", { error: errorMessage(error) });
		return null;
	}
}

async function readStats(): Promise<SessionStats> {
	return (await chromeLocalGet(LOCAL_KEYS.sessionStats)) ?? { ...EMPTY_SESSION_STATS };
}

/** The port toast an execution result earns, if any (the Live view toasts cancels itself). */
function toastFor(
	rec: Recommendation,
	result: ExecutionResult
): { level: ToastLevel; text: string } | null {
	if (result.outcome === "executed") {
		const seconds = (result.elapsedMs / MS_PER_SECOND).toFixed(1);
		return { level: "info", text: COPY.toast.played(rec.chosen.san, seconds, result.tier) };
	}
	if (result.outcome === "failed" && result.reason === EXECUTOR.reasons.unverified)
		return { level: "warn", text: COPY.toast.notVerified };
	return null;
}

export class PanelBroadcaster {
	private readonly conns = new Set<Connection>();
	private readonly lastExecutions = new Map<number, ExecutionResult>();
	private readonly offs: Array<() => void> = [];
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private readonly minIntervalMs: number;
	private lastPushAt = Number.NEGATIVE_INFINITY;
	private trailing: unknown = null;
	private disposed = false;

	constructor(
		private readonly sources: SnapshotSources,
		options: PanelBroadcasterOptions = {}
	) {
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.now = options.now ?? defaultNow;
		this.minIntervalMs = options.minIntervalMs ?? TIMINGS.panelSnapshotMinIntervalMs;
		this.offs.push(
			acceptPorts<PanelPortMessage, never>(PORT_NAMES.panel, (port) => this.accept(port)),
			onStorageChanged("local", (changes) => {
				if (WATCHED_KEYS.some((key) => key in changes)) this.notify();
			})
		);
	}

	/** Open panel ports. */
	connections(): number {
		return this.conns.size;
	}

	/** The snapshot for the panel behind `sender` (`PANEL_GET_SNAPSHOT`). */
	snapshotFor(sender?: chrome.runtime.MessageSender): Promise<PanelSnapshot> {
		return this.build(windowIdOf(sender));
	}

	/**
	 * Something the snapshot reflects changed. Pushes at once when the last push
	 * is older than the interval; otherwise one trailing push at the end of it.
	 */
	notify(): void {
		if (this.disposed || this.trailing !== null) return;
		const wait = this.lastPushAt + this.minIntervalMs - this.now();
		if (wait <= 0) {
			void this.pushAll();
			return;
		}
		this.trailing = this.scheduler.setTimeout(() => {
			this.trailing = null;
			void this.pushAll();
		}, wait);
	}

	toast(level: ToastLevel, text: string): void {
		for (const conn of [...this.conns]) conn.port.post({ kind: "toast", level, text });
	}

	/**
	 * Surface a tab's executor: results are stamped (`at`), remembered, toasted and
	 * pushed; hand-state changes are pushed. Returns the detach (drops the memory).
	 */
	observeExecutor(tabId: number, executor: Pick<ExecutorHandle, "on">): () => void {
		const surface = (report: ExecutionReport): void => {
			const result: ExecutionResult = { ...report.result, at: this.now() };
			this.lastExecutions.set(tabId, result);
			const toast = toastFor(report.rec, result);
			if (toast) this.toast(toast.level, toast.text);
			this.notify();
		};
		const offs = [
			executor.on("executed", surface),
			executor.on("failed", surface),
			executor.on("aborted", surface),
			executor.on("skipped", surface),
			executor.on("hand", () => this.notify()),
		];
		return () => {
			for (const off of offs) off();
			this.lastExecutions.delete(tabId);
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const off of this.offs.splice(0)) off();
		if (this.trailing !== null) {
			this.scheduler.clearTimeout(this.trailing);
			this.trailing = null;
		}
		this.conns.clear();
		this.lastExecutions.clear();
	}

	private accept(port: AcceptedPort<PanelPortMessage, never>): void {
		const conn: Connection = { port, windowId: windowIdOf(port.sender) };
		this.conns.add(conn);
		const off = port.onDisconnect(() => {
			this.conns.delete(conn);
			off();
		});
		log.debug("panel-broadcaster: panel connected", { windowId: conn.windowId });
		void this.push([conn]); // the first snapshot goes out within one tick of the connect
	}

	private async pushAll(): Promise<void> {
		this.lastPushAt = this.now();
		await this.push([...this.conns]);
	}

	/** One build per window; posted only to the connections still open afterwards. */
	private async push(conns: readonly Connection[]): Promise<void> {
		const byWindow = new Map<number | null, Connection[]>();
		for (const conn of conns) {
			const group = byWindow.get(conn.windowId);
			if (group) group.push(conn);
			else byWindow.set(conn.windowId, [conn]);
		}
		for (const [windowId, group] of byWindow) {
			let snapshot: PanelSnapshot;
			try {
				snapshot = await this.build(windowId);
			} catch (error) {
				log.warn("panel-broadcaster: snapshot build failed", { error: errorMessage(error) });
				continue;
			}
			if (this.disposed) return;
			for (const conn of group) {
				if (this.conns.has(conn)) conn.port.post({ kind: "snapshot", snapshot });
			}
		}
	}

	private async build(windowId: number | null): Promise<PanelSnapshot> {
		const tabId = await activeTabId(windowId);
		const [settings, stats] = await Promise.all([getSettings(), readStats()]);
		const session = tabId === null ? null : this.sources.session(tabId);
		const executor = tabId === null ? null : this.sources.executor(tabId);
		const hand = tabId === null ? null : this.sources.hand;

		const view: GameSessionView = {
			...(session?.view() ?? IDLE_VIEW),
			hand: executor ? executor.handView() : "detached",
		};
		const last = tabId === null ? undefined : this.lastExecutions.get(tabId);
		if (last) view.lastExecution = last;

		const autoMove: PanelSnapshot["autoMove"] = { armed: executor?.isArmed() ?? false };
		const pending = executor?.pendingMove() ?? null;
		if (pending) {
			autoMove.scheduledAt = pending.rec.plan.deadlineMs;
			autoMove.plan = pending.rec.plan;
		}

		const executorState: PanelSnapshot["executor"] = {
			debuggerAttached: tabId !== null && hand ? hand.debugger.isAttached(tabId) : false,
		};
		const lastError = tabId !== null && hand ? hand.debugger.lastError(tabId) : undefined;
		if (lastError !== undefined) executorState.lastError = lastError;

		const focus =
			tabId !== null && hand
				? hand.focus.snapshot(tabId)
				: { pageHasFocus: false, blurSeenThisMove: false };

		const snapshot: PanelSnapshot = {
			license: this.sources.license(),
			site: view.site,
			pageKind: view.pageKind,
			session: view,
			engine: this.sources.engineStatus() ?? { ...DEFAULT_ENGINE_STATUS, nnue: [] },
			executor: executorState,
			settings,
			autoMove,
			stats,
			focus: {
				...focus,
				handsOff: isLive(view.state),
				realPointerEventsDuringHand:
					tabId !== null && hand ? hand.ownership.realPointerCount(tabId) : 0,
			},
		};
		const recommendation = session?.recommendation() ?? null;
		if (recommendation) snapshot.recommendation = recommendation;
		const opponent = session?.opponent() ?? null;
		if (opponent) snapshot.opponent = opponent;
		return snapshot;
	}
}
