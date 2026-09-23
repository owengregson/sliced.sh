/**
 * Delivery pacing for a search's live updates: an update goes out at once when an iteration
 * completes, otherwise at most every `coalesceMs` — the frame is produced when it is delivered,
 * so it is always the newest one.
 */

import type { Mailbox } from "./mailbox";
import type { UciScheduler } from "./scheduler";

export class UpdateCoalescer<T> {
	private flushTimer: unknown;
	private lastEmitAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly sched: UciScheduler,
		private readonly coalesceMs: number,
		private readonly mailbox: Mailbox<T>,
		private readonly produce: () => T
	) {}

	emit(): void {
		this.cancel();
		this.lastEmitAt = this.sched.now();
		this.mailbox.put(this.produce());
	}

	schedule(): void {
		if (this.flushTimer !== undefined) return;
		const elapsed = this.sched.now() - this.lastEmitAt;
		const wait = Math.max(0, this.coalesceMs - elapsed);
		this.flushTimer = this.sched.setTimeout(() => {
			this.flushTimer = undefined;
			this.emit();
		}, wait);
	}

	cancel(): void {
		if (this.flushTimer === undefined) return;
		this.sched.clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
	}
}
