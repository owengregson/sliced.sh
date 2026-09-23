// src/offscreen/engine-host/info-coalescer.ts
/**
 * §6.4 backpressure: `info` lines are coalesced per multipv index — the newest line of each
 * index wins — and forwarded at most every `TIMINGS.engineInfoForwardMs`, in index order. Any
 * other output flushes the pending lines first, so the relayed order is kept.
 */

import { TIMINGS } from "@core/constants/timings";
import type { TimerScheduler } from "@core/util/scheduler";

export class InfoCoalescer {
	private readonly pending = new Map<number, string>();
	private timer: unknown;
	private lastFlushAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly sched: TimerScheduler,
		private readonly forward: (line: string) => void
	) {}

	/** Hold `line` as the newest of its multipv index and make sure a flush is due. */
	add(multipv: number, line: string): void {
		this.pending.set(multipv, line);
		this.schedule();
	}

	/** Forward every pending line now, in multipv order. */
	flush(): void {
		this.cancel();
		if (this.pending.size === 0) return;
		this.lastFlushAt = this.sched.now();
		const keys = [...this.pending.keys()].sort((a, b) => a - b);
		for (const k of keys) this.forward(this.pending.get(k) as string);
		this.pending.clear();
	}

	/** Drop the pending lines and the flush timer (a new engine, a crash, disposal). */
	reset(): void {
		this.cancel();
		this.pending.clear();
	}

	private schedule(): void {
		if (this.timer !== undefined) return;
		const elapsed = this.sched.now() - this.lastFlushAt;
		const wait = Math.max(0, TIMINGS.engineInfoForwardMs - elapsed);
		this.timer = this.sched.setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, wait);
	}

	private cancel(): void {
		if (this.timer === undefined) return;
		this.sched.clearTimeout(this.timer);
		this.timer = undefined;
	}
}
