/**
 * The client's `uciok` / `readyok` waits. Each wait has its own timeout; on expiry the wait is
 * rejected and then `onTimeout` runs (the client's crash path).
 */

import type { UciScheduler } from "./scheduler";

export type WaitKind = "uciok" | "readyok";

interface Waiter {
	kind: WaitKind;
	resolve: () => void;
	reject: (err: Error) => void;
	timer: unknown;
}

export class ReadyWaiters {
	private waiters: Waiter[] = [];

	constructor(
		private readonly sched: UciScheduler,
		private readonly timeoutMs: number,
		private readonly onTimeout: (kind: WaitKind) => void
	) {}

	/**
	 * Register a `kind` waiter, then `send()`. The waiter is registered first so a transport that
	 * answers synchronously is not missed; a synchronous `send` throw removes it again (no dangling
	 * timer) and rejects.
	 */
	sendAndWait(kind: WaitKind, send: () => void): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { kind, resolve, reject, timer: undefined };
			waiter.timer = this.sched.setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				reject(new Error(`UciEngine: timed out waiting for ${kind}`));
				this.onTimeout(kind);
			}, this.timeoutMs);
			this.waiters.push(waiter);
			try {
				send();
			} catch (err) {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				this.sched.clearTimeout(waiter.timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	settle(kind: WaitKind): void {
		const hit = this.waiters.filter((w) => w.kind === kind);
		this.waiters = this.waiters.filter((w) => w.kind !== kind);
		for (const w of hit) {
			this.sched.clearTimeout(w.timer);
			w.resolve();
		}
	}

	rejectAll(err: Error): void {
		const all = this.waiters;
		this.waiters = [];
		for (const w of all) {
			this.sched.clearTimeout(w.timer);
			w.reject(err);
		}
	}
}
