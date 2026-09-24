import type { Scheduler } from "@core/util/scheduler";

/**
 * Run at most once per `minIntervalMs`: a request inside the interval schedules one trailing run
 * at its end (so a burst ends with the newest state) and further requests join it.
 */
export class TrailingThrottle {
	private lastRunAt = Number.NEGATIVE_INFINITY;
	private trailing: unknown = null;

	constructor(
		private readonly scheduler: Scheduler,
		private readonly now: () => number,
		private readonly minIntervalMs: number,
		private readonly run: () => void
	) {}

	request(): void {
		if (this.trailing !== null) return;
		const wait = this.lastRunAt + this.minIntervalMs - this.now();
		if (wait <= 0) {
			this.fire();
			return;
		}
		this.trailing = this.scheduler.setTimeout(() => {
			this.trailing = null;
			this.fire();
		}, wait);
	}

	/** Drop a scheduled trailing run. */
	cancel(): void {
		if (this.trailing === null) return;
		this.scheduler.clearTimeout(this.trailing);
		this.trailing = null;
	}

	private fire(): void {
		this.lastRunAt = this.now();
		this.run();
	}
}
