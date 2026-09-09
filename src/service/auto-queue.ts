/**
 * Auto-queue (§3.3 `game-over` → `waiting-for-game`, Appendix F §4.3): when
 * `Settings.automation.autoQueue` is on, a finished game is followed by the
 * site's own new-game control after a human delay sampled uniformly from
 * `TIMINGS.autoQueueDelayRangeMs`. The command is `startNewGame` on the game
 * port — the content adapter activates the button the page already offers
 * (`tryStartNewGame`), which is the one permitted synthetic activation (§9.1);
 * nothing here opens a tab, a window or a notification (§13.4).
 *
 * One pending queue per tab: a second `gameEnded` replaces the first, and a new
 * game starting (or the user disabling the session) cancels it.
 */

import type { GamePortCommand } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import type { Rng } from "@core/rng";
import { defaultScheduler, type Scheduler } from "@core/util/scheduler";

export interface AutoQueueLink {
	post(tabId: number, cmd: GamePortCommand): boolean;
}

export interface AutoQueueOptions {
	link: AutoQueueLink;
	scheduler?: Scheduler;
	/** Injected so the delay is reproducible (C: every stochastic function takes an `Rng`). */
	rng: Rng;
	delayRangeMs?: readonly [number, number];
	/** Called once the command has been posted (the session logs / notifies). */
	onQueued?: (tabId: number, delayMs: number) => void;
}

export class AutoQueue {
	private readonly timers = new Map<number, unknown>();
	private readonly scheduler: Scheduler;
	private readonly range: readonly [number, number];
	private disposed = false;

	constructor(private readonly options: AutoQueueOptions) {
		this.scheduler = options.scheduler ?? defaultScheduler;
		const range = options.delayRangeMs ?? TIMINGS.autoQueueDelayRangeMs;
		this.range = [range[0] ?? 0, range[1] ?? 0];
	}

	/** Sampled delay before the new-game control is activated. */
	delayMs(): number {
		const [lo, hi] = this.range;
		return lo + this.options.rng.next() * Math.max(0, hi - lo);
	}

	/** Queue a new game on `tabId`; replaces any pending queue for that tab. */
	schedule(tabId: number): number {
		this.cancel(tabId);
		if (this.disposed) return 0;
		const delay = this.delayMs();
		const timer = this.scheduler.setTimeout(() => {
			this.timers.delete(tabId);
			const posted = this.options.link.post(tabId, { kind: "startNewGame" });
			log.info("auto-queue: new game requested", { tabId, delayMs: delay, posted });
			this.options.onQueued?.(tabId, delay);
		}, delay);
		this.timers.set(tabId, timer);
		log.debug("auto-queue: scheduled", { tabId, delayMs: delay });
		return delay;
	}

	isPending(tabId: number): boolean {
		return this.timers.has(tabId);
	}

	cancel(tabId: number): void {
		const timer = this.timers.get(tabId);
		if (timer === undefined) return;
		this.timers.delete(tabId);
		this.scheduler.clearTimeout(timer);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [tabId] of [...this.timers]) this.cancel(tabId);
	}
}
