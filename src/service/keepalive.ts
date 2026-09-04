/**
 * Service-worker keepalive (Appendix B §4, H.9). While any reason is held —
 * a live game, an attached debugger — a repeating `ALARM_NAMES.keepalive`
 * alarm (0.5 min, Chrome's minimum) wakes the SW; the alarm handler itself
 * does nothing, receipt is the point. Alarm calls are serialised so
 * interleaved hold/release always leaves the alarm matching the reason set.
 */

import { alarmClear, alarmCreate, alarmGet } from "@core/chrome/alarms";
import { ALARM_CADENCE_MINUTES, ALARM_NAMES } from "@core/constants/alarms";
import { log } from "@core/logger";

export class Keepalive {
	private readonly held = new Set<string>();
	private chain: Promise<void> = Promise.resolve();

	hold(reason: string): Promise<void> {
		if (this.held.has(reason)) return this.chain;
		this.held.add(reason);
		return this.reconcile();
	}

	release(reason: string): Promise<void> {
		if (!this.held.delete(reason)) return this.chain;
		return this.reconcile();
	}

	isHeld(): boolean {
		return this.held.size > 0;
	}

	reasons(): string[] {
		return [...this.held];
	}

	/**
	 * The alarm's only job is to wake the SW. `held` is in-memory while the
	 * alarm persists, so after an SW restart a tick with nothing held clears
	 * the orphaned alarm instead of waking the worker forever.
	 */
	onAlarm(): void {
		log.debug("keepalive: tick", { reasons: this.reasons() });
		if (!this.isHeld()) void this.reconcile();
	}

	dispose(): Promise<void> {
		this.held.clear();
		return this.reconcile();
	}

	private reconcile(): Promise<void> {
		this.chain = this.chain.then(() => this.apply()).catch(() => {});
		return this.chain;
	}

	private async apply(): Promise<void> {
		try {
			if (this.held.size > 0) {
				if (await alarmGet(ALARM_NAMES.keepalive)) return;
				await alarmCreate(ALARM_NAMES.keepalive, {
					periodInMinutes: ALARM_CADENCE_MINUTES.keepalive,
				});
			} else {
				await alarmClear(ALARM_NAMES.keepalive);
			}
		} catch (error) {
			log.warn("keepalive: alarm update failed", error);
		}
	}
}
