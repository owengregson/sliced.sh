/**
 * Waits for a posted `restart` to take effect. A waiter settles when the host reports `ready`
 * *after* a non-ready status (so a stale `ready` in flight cannot resolve it), or rejects after
 * the timeout.
 */

import type { PortScheduler } from "@core/messaging/ports";
import type { EngineStatus } from "@typedefs/engine";

interface RestartWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: unknown;
	/** Set once a non-`ready` status has been seen since the restart was posted. */
	armed: boolean;
}

export class RestartWaiters {
	private waiters: RestartWaiter[] = [];

	constructor(
		private readonly scheduler: PortScheduler,
		private readonly timeoutMs: number
	) {}

	/** Register a waiter (and its timeout), then `post()` the restart. */
	wait(post: () => void): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const waiter: RestartWaiter = { resolve, reject, timer: undefined, armed: false };
			waiter.timer = this.scheduler.setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				reject(new Error("remote-engine: timed out waiting for the engine to become ready"));
			}, this.timeoutMs);
			this.waiters.push(waiter);
			post();
		});
	}

	/** A status from the host: a non-ready one arms every waiter, `ready` settles the armed ones. */
	observe(state: EngineStatus["state"]): void {
		if (state !== "ready") {
			for (const w of this.waiters) w.armed = true;
			return;
		}
		const done = this.waiters.filter((w) => w.armed);
		this.waiters = this.waiters.filter((w) => !w.armed);
		for (const w of done) {
			this.scheduler.clearTimeout(w.timer);
			w.resolve();
		}
	}

	rejectAll(error: Error): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) {
			this.scheduler.clearTimeout(w.timer);
			w.reject(error);
		}
	}
}
