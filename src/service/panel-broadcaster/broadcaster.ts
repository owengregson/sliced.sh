/** The `PanelBroadcaster` (see `@service/panel-broadcaster` for the contract). */

import { onStorageChanged } from "@core/chrome/storage";
import { onTabActivated, onTabRemoved } from "@core/chrome/tabs";
import { onWindowFocusChanged } from "@core/chrome/windows";
import type {
	PanelPortCommand,
	PanelPortMessage,
	PanelSnapshot,
	PanelToast,
} from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { acceptPorts } from "@core/messaging/ports";
import { getSettings } from "@core/storage/settings-storage";
import { errorMessage } from "@core/util/errors";
import { defaultNow, defaultScheduler, type Scheduler } from "@core/util/scheduler";
import type { ExecutionReport } from "@service/move-executor";
import {
	byWindow,
	type Connection,
	PanelConnections,
	type PanelPort,
} from "@service/panel-broadcaster/connections";
import {
	activeTabId,
	assembleSnapshot,
	readStats,
	type ToastLevel,
	toastFor,
} from "@service/panel-broadcaster/snapshot";
import type { ExecutorHandle, SnapshotSources } from "@service/panel-broadcaster/sources";
import { TrailingThrottle } from "@service/panel-broadcaster/throttle";
import type { ExecutionResult } from "@typedefs/game";
import type { TimingLogEntry } from "@typedefs/timing";

export interface PanelBroadcasterOptions {
	scheduler?: Scheduler;
	now?: () => number;
	/** Defaults to `TIMINGS.panelSnapshotMinIntervalMs`. */
	minIntervalMs?: number;
}

/** Storage keys whose change alone warrants a fresh snapshot. */
const WATCHED_KEYS: readonly string[] = [
	LOCAL_KEYS.settings,
	LOCAL_KEYS.licenseState,
	LOCAL_KEYS.sessionStats,
];

export class PanelBroadcaster {
	private readonly conns = new PanelConnections();
	private readonly lastExecutions = new Map<number, ExecutionResult>();
	private readonly offs: Array<() => void> = [];
	private readonly now: () => number;
	private readonly throttle: TrailingThrottle;
	private disposed = false;
	/** Build counter: a connection never accepts a snapshot older than the last one posted. */
	private seq = 0;

	constructor(
		private readonly sources: SnapshotSources,
		options: PanelBroadcasterOptions = {}
	) {
		this.now = options.now ?? defaultNow;
		this.throttle = new TrailingThrottle(
			options.scheduler ?? defaultScheduler,
			this.now,
			options.minIntervalMs ?? TIMINGS.panelSnapshotMinIntervalMs,
			() => void this.push(this.conns.all())
		);
		this.offs.push(
			// The panel follows its window's selected tab even when neither tab has a new
			// position to publish. A previous lobby/unsupported snapshot must not persist
			// over an already-running game until its next engine or board event.
			onTabActivated(() => this.notify()),
			onTabRemoved(() => this.notify()),
			onWindowFocusChanged(() => this.notify()),
			acceptPorts<PanelPortMessage, PanelPortCommand>(PORT_NAMES.panel, (port) => this.accept(port)),
			onStorageChanged("local", (changes) => {
				if (WATCHED_KEYS.some((key) => key in changes)) this.notify();
			})
		);
	}

	/** Open panel ports. */
	connections(): number {
		return this.conns.size;
	}

	/** The snapshot for a panel's window (`PANEL_GET_SNAPSHOT`); `null` → the last-focused one. */
	snapshotFor(windowId: number | null): Promise<PanelSnapshot> {
		return this.build(windowId);
	}

	/** The timing log is global, like its export; publish row updates to connected panels. */
	timingEntry(entry: TimingLogEntry): void {
		if (this.disposed) return;
		for (const conn of this.conns.all()) conn.port.post({ kind: "timingLog", entry });
	}

	/**
	 * Something the snapshot reflects changed. Pushes at once when the last push
	 * is older than the interval; otherwise one trailing push at the end of it.
	 */
	notify(): void {
		if (this.disposed) return;
		this.throttle.request();
	}

	/**
	 * Post a toast named by `TOAST_KEYS` (the panel renders `COPY.toast[key]`): to every panel,
	 * or — with `tabId` — only to the panels whose window shows that tab.
	 */
	async toast(level: ToastLevel, toast: PanelToast, tabId?: number): Promise<void> {
		const conns = tabId === undefined ? this.conns.all() : await this.conns.showing(tabId);
		for (const conn of conns) {
			if (this.conns.has(conn)) conn.port.post({ kind: "toast", level, ...toast });
		}
	}

	/**
	 * Surface a tab's executor: results are stamped (`at`), remembered, toasted and
	 * pushed; hand-state changes are pushed. Returns the detach (drops the memory).
	 */
	observeExecutor(tabId: number, executor: Pick<ExecutorHandle, "on">): () => void {
		const surface = (report: ExecutionReport): void => {
			const result: ExecutionResult = { ...report.result, at: this.now() };
			this.lastExecutions.set(tabId, result);
			const toast = toastFor(result);
			if (toast) void this.toast(toast.level, toast.toast, tabId);
			this.notify();
		};
		const offs = [
			executor.on("executed", surface),
			// Fix F: a premove gesture is an execution result like any other for the panel's
			// Last-action row — and `toastFor` gives it no "Played …" toast, because nothing has been
			// played and nothing can tell whether the site even kept it.
			executor.on("dispatched", surface),
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
		this.throttle.cancel();
		for (const conn of this.conns.all()) this.conns.drop(conn);
		this.lastExecutions.clear();
	}

	private accept(port: PanelPort): void {
		const conn = this.conns.add(port);
		conn.offs.push(
			port.onDisconnect(() => this.conns.drop(conn)),
			port.onMessage((msg) => {
				if (msg.kind !== "hello" || msg.windowId === conn.windowId) return;
				conn.windowId = msg.windowId;
				log.debug("panel-broadcaster: panel window", { windowId: msg.windowId });
				void this.push([conn]); // its own window's game tab, not the last-focused one's
			})
		);
		log.debug("panel-broadcaster: panel connected");
		void this.push([conn]); // the first snapshot goes out within one tick of the connect
	}

	/** One build per window; posted only to the connections still open, newest build wins. */
	private async push(conns: readonly Connection[]): Promise<void> {
		this.seq += 1;
		const seq = this.seq;
		for (const [windowId, group] of byWindow(conns)) {
			let snapshot: PanelSnapshot;
			try {
				snapshot = await this.build(windowId);
			} catch (error) {
				log.warn("panel-broadcaster: snapshot build failed", { error: errorMessage(error) });
				continue;
			}
			if (this.disposed) return;
			for (const conn of group) {
				if (!this.conns.has(conn) || conn.lastSeq >= seq) continue;
				conn.lastSeq = seq;
				conn.port.post({ kind: "snapshot", snapshot });
			}
		}
	}

	private async build(windowId: number | null): Promise<PanelSnapshot> {
		const tabId = await activeTabId(windowId);
		const [settings, stats] = await Promise.all([getSettings(), readStats()]);
		return assembleSnapshot(this.sources, {
			tabId,
			settings,
			stats,
			lastExecution: tabId === null ? undefined : this.lastExecutions.get(tabId),
		});
	}
}
