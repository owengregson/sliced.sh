/**
 * `chrome.debugger` lifecycle (Appendix H.7, G §5; §9.2 amended by §13.4).
 *
 * One attachment per tab, deduped across concurrent callers, protocol from
 * `CDP.protocolVersion`. **Attach happens at arm time** — the game session
 * calls `ensureAttached` from the waiting view when auto-play is armed so the
 * infobar's layout shift and focus side effects land outside any move window;
 * the executor never attaches mid-game (a missing attachment fails the move).
 * The attach map is rebuilt from `chrome.debugger.getTargets()` on
 * construction (a restarted worker must not assume "detached"); Chrome's
 * `onDetach` (`canceled_by_user` from the infobar / DevTools, `target_closed`)
 * clears the state and notifies subscribers; an idle tab is detached after
 * `TIMINGS.debuggerIdleDetachMs` without `send`/`touch`. The keepalive is held
 * while anything is attached (an attached debugger keeps the worker alive on
 * Chrome 118+, the alarm covers older builds and the gaps).
 */

import {
	debuggerAttach,
	debuggerDetach,
	debuggerGetTargets,
	debuggerSend,
	onDebuggerDetach,
} from "@core/chrome/debugger";
import {
	CDP,
	DEBUGGER_ATTACH_PATTERNS,
	DEBUGGER_ATTACH_REASONS,
	DEBUGGER_DETACH_REASONS,
	DEBUGGER_KEEPALIVE_REASON,
} from "@core/constants/cdp";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { defaultNow, defaultScheduler, type Scheduler } from "@core/util/scheduler";
import type { Keepalive } from "@service/keepalive";

export type DetachReason = (typeof DEBUGGER_DETACH_REASONS)[keyof typeof DEBUGGER_DETACH_REASONS];
export type DetachListener = (tabId: number, reason: DetachReason) => void;

export interface DebuggerManagerOptions {
	keepalive?: Keepalive;
	scheduler?: Scheduler;
	now?: () => number;
	/** Idle detach delay; defaults to `TIMINGS.debuggerIdleDetachMs`. */
	idleDetachMs?: number;
}

/** Chrome's attach error text → the registry's user-facing reason. */
export function attachErrorReason(error: unknown): string {
	const text = errorMessage(error).toLowerCase();
	for (const [key, needle] of DEBUGGER_ATTACH_PATTERNS) {
		if (text.includes(needle)) return DEBUGGER_ATTACH_REASONS[key];
	}
	return DEBUGGER_ATTACH_REASONS.unknown;
}

export class DebuggerManager {
	/** Resolves once the attach map has been rebuilt from `getTargets()`. */
	readonly ready: Promise<void>;
	private readonly attached = new Set<number>();
	private readonly inflight = new Map<number, Promise<void>>();
	private readonly idleTimers = new Map<number, unknown>();
	private readonly errors = new Map<number, string>();
	private readonly listeners = new Set<DetachListener>();
	private readonly keepalive: Keepalive | null;
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private readonly idleDetachMs: number;
	private offDetach: () => void;
	private disposed = false;

	constructor(options: DebuggerManagerOptions = {}) {
		this.keepalive = options.keepalive ?? null;
		this.scheduler = options.scheduler ?? defaultScheduler;
		this.now = options.now ?? defaultNow;
		this.idleDetachMs = options.idleDetachMs ?? TIMINGS.debuggerIdleDetachMs;
		this.offDetach = onDebuggerDetach((source, reason) => {
			const tabId = source.tabId;
			if (typeof tabId !== "number" || !this.attached.has(tabId)) return;
			log.info("debugger: detached by Chrome", { tabId, reason });
			this.markDetached(
				tabId,
				reason === DEBUGGER_DETACH_REASONS.targetClosed
					? DEBUGGER_DETACH_REASONS.targetClosed
					: DEBUGGER_DETACH_REASONS.canceledByUser
			);
		});
		this.ready = this.rebuild();
	}

	isAttached(tabId: number): boolean {
		return this.attached.has(tabId);
	}

	attachedTabs(): number[] {
		return [...this.attached];
	}

	/** The user-facing reason of the last failed attach for `tabId`, if any. */
	lastError(tabId: number): string | undefined {
		return this.errors.get(tabId);
	}

	/**
	 * Attach once (concurrent calls share the in-flight attach). Rejects with
	 * the user-facing reason from the registry. Call at arm time, never mid-game.
	 */
	async ensureAttached(tabId: number): Promise<void> {
		// A restarted worker must see the rebuilt map before deciding to attach.
		await this.ready;
		if (this.attached.has(tabId)) {
			this.touch(tabId);
			return;
		}
		const pending = this.inflight.get(tabId);
		if (pending) return pending;
		const p = this.attach(tabId).finally(() => {
			if (this.inflight.get(tabId) === p) this.inflight.delete(tabId);
		});
		this.inflight.set(tabId, p);
		return p;
	}

	async detach(tabId: number): Promise<void> {
		if (!this.attached.has(tabId)) return;
		await this.detachWith(tabId, DEBUGGER_DETACH_REASONS.requested);
	}

	/** Reset the idle timer (every executor dispatch goes through `send`, which touches). */
	touch(tabId: number): void {
		if (!this.attached.has(tabId) || this.disposed) return;
		this.clearIdle(tabId);
		this.idleTimers.set(
			tabId,
			this.scheduler.setTimeout(() => {
				this.idleTimers.delete(tabId);
				void this.detachWith(tabId, DEBUGGER_DETACH_REASONS.idle);
			}, this.idleDetachMs)
		);
	}

	send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
		if (!this.attached.has(tabId)) {
			return Promise.reject(new Error(`debugger: not attached to tab ${tabId}`));
		}
		this.touch(tabId);
		return debuggerSend(tabId, method, params);
	}

	onDetached(listener: DetachListener): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	/** Drop listeners, timers and in-memory state; the attachments themselves survive (SW eviction). */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.offDetach();
		this.offDetach = () => {};
		for (const tabId of [...this.idleTimers.keys()]) this.clearIdle(tabId);
		this.listeners.clear();
		this.inflight.clear();
		this.attached.clear();
		void this.keepalive?.release(DEBUGGER_KEEPALIVE_REASON);
	}

	private async rebuild(): Promise<void> {
		try {
			const targets = await debuggerGetTargets();
			for (const t of targets) {
				if (t.attached && typeof t.tabId === "number") this.markAttached(t.tabId);
			}
			if (this.attached.size > 0)
				log.info("debugger: rebuilt attach map", { tabs: this.attachedTabs() });
		} catch (error) {
			log.warn("debugger: getTargets failed", error);
		}
	}

	private async attach(tabId: number): Promise<void> {
		try {
			await debuggerAttach(tabId, CDP.protocolVersion);
		} catch (error) {
			const reason = attachErrorReason(error);
			this.errors.set(tabId, reason);
			log.warn("debugger: attach failed", { tabId, reason, error: errorMessage(error) });
			throw new Error(reason, { cause: error });
		}
		if (this.disposed) return;
		this.errors.delete(tabId);
		this.markAttached(tabId);
		log.info("debugger: attached", { tabId, at: this.now() });
	}

	private async detachWith(tabId: number, reason: DetachReason): Promise<void> {
		try {
			await debuggerDetach(tabId);
		} catch (error) {
			// Already gone (tab closed, user cancelled): the state below is what matters.
			log.debug("debugger: detach reported an error", { tabId, error: errorMessage(error) });
		}
		if (this.attached.has(tabId)) this.markDetached(tabId, reason);
	}

	private markAttached(tabId: number): void {
		const first = this.attached.size === 0;
		this.attached.add(tabId);
		this.touch(tabId);
		if (first) void this.keepalive?.hold(DEBUGGER_KEEPALIVE_REASON);
	}

	private markDetached(tabId: number, reason: DetachReason): void {
		this.attached.delete(tabId);
		this.clearIdle(tabId);
		if (this.attached.size === 0) void this.keepalive?.release(DEBUGGER_KEEPALIVE_REASON);
		for (const l of [...this.listeners]) l(tabId, reason);
	}

	private clearIdle(tabId: number): void {
		const handle = this.idleTimers.get(tabId);
		if (handle === undefined) return;
		this.scheduler.clearTimeout(handle);
		this.idleTimers.delete(tabId);
	}
}
