import { REVIEW } from "@core/constants/review";
import type { Scheduler } from "@core/util/scheduler";

/** Identity is local to one execution; late cleanup cannot release a newer operation. */
export interface InputCriticalUpdate {
	token: object;
	busy: boolean;
	/** Absolute lead-guard boundary, not the release deadline. */
	availableUntil: number | null;
	done: boolean;
}

/** Independent of hand/UI phases: orientation and decision can contain seconds of idle time. */
export class InputCriticalWindow {
	private readonly token = {};
	private timer: unknown = null;
	private generation = 0;
	private until: number | null = null;
	private critical = false;
	private closed = false;

	constructor(
		private readonly now: () => number,
		private readonly scheduler: Scheduler,
		private readonly publish: (update: InputCriticalUpdate) => void
	) {}

	/** Refine from the reserved gesture to its actual planned approach, never change the plan. */
	approachAt(atMs: number | null): void {
		if (this.closed) return;
		this.clearTimer();
		this.until = atMs === null ? null : atMs - REVIEW.inputLeadMs;
		const generation = this.generation;
		if (this.until !== null && this.until > this.now()) {
			this.timer = this.scheduler.setTimeout(() => {
				if (this.closed || generation !== this.generation) return;
				this.timer = null;
				this.emit();
			}, this.until - this.now());
		}
		this.emit();
	}

	/** Includes admitted presses, their ack waits, stationary holds and recovery releases. */
	setCritical(busy: boolean): void {
		if (this.closed || this.critical === busy) return;
		this.critical = busy;
		this.emit();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearTimer();
		this.until = null;
		this.critical = false;
		this.emit();
	}

	private clearTimer(): void {
		this.generation += 1;
		if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
		this.timer = null;
	}

	private emit(): void {
		this.publish({
			token: this.token,
			busy: !this.closed && (this.critical || (this.until !== null && this.until <= this.now())),
			availableUntil: this.until,
			done: this.closed,
		});
	}
}
