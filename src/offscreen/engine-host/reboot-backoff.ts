// src/offscreen/engine-host/reboot-backoff.ts
/**
 * The crash-reboot schedule: after the n-th consecutive crash the engine reboots after
 * `TIMINGS.engineRestartBackoffMs[n]`; once the steps are exhausted nothing is armed and the
 * host stays `crashed`. A completed search or an explicit restart resets the count.
 */

import { TIMINGS } from "@core/constants/timings";
import type { TimerScheduler } from "@core/util/scheduler";

export class RebootBackoff {
	/** Consecutive crashes since the last reset. */
	attempt = 0;
	private timer: unknown;

	constructor(private readonly sched: TimerScheduler) {}

	/** A reboot is armed. */
	get pending(): boolean {
		return this.timer !== undefined;
	}

	/** Arm the next step's reboot; false (nothing armed) once the steps are exhausted. */
	arm(reboot: () => void): boolean {
		const steps = TIMINGS.engineRestartBackoffMs;
		if (this.attempt >= steps.length) return false;
		const wait = steps[this.attempt] as number;
		this.attempt++;
		this.timer = this.sched.setTimeout(() => {
			this.timer = undefined;
			reboot();
		}, wait);
		return true;
	}

	cancel(): void {
		if (this.timer === undefined) return;
		this.sched.clearTimeout(this.timer);
		this.timer = undefined;
	}
}
