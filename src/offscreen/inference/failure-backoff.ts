// src/offscreen/inference/failure-backoff.ts
/**
 * Key → when it last failed to load and how many consecutive failures it has had. A failure is
 * treated as transient (a stalled relay, a download the port dropped, a runtime that had not
 * warmed up yet), so the key is skipped for a while and then tried again rather than disabled
 * for the life of the document. The cooldown doubles per consecutive failure up to `retryMaxMs`,
 * so a genuinely broken model settles at one re-read every 15 minutes instead of one every 30
 * seconds; a success clears the entry.
 */

import { TIMINGS } from "@core/constants/timings";

export interface BackoffOptions {
	/** First cooldown after a failed load; default `TIMINGS.timingBandRetryMs`. Doubles per failure. */
	retryAfterMs?: number;
	/** Ceiling for the doubling cooldown; default `TIMINGS.timingBandRetryMaxMs`. */
	retryMaxMs?: number;
}

export class FailureBackoff<K> {
	private readonly failures = new Map<K, { at: number; count: number }>();
	private readonly retryAfterMs: number;
	private readonly retryMaxMs: number;

	constructor(
		private readonly now: () => number,
		options: BackoffOptions
	) {
		this.retryAfterMs = options.retryAfterMs ?? TIMINGS.timingBandRetryMs;
		this.retryMaxMs = Math.max(this.retryAfterMs, options.retryMaxMs ?? TIMINGS.timingBandRetryMaxMs);
	}

	/** The wait after `count` consecutive failures. */
	cooldownFor(count: number): number {
		return Math.min(this.retryMaxMs, this.retryAfterMs * 2 ** Math.max(0, count - 1));
	}

	/**
	 * True while `key`'s last failure is still inside its (backing-off) retry cooldown. Once due
	 * for another attempt the count stays, so the next wait is longer.
	 */
	inCooldown(key: K): boolean {
		const f = this.failures.get(key);
		return f !== undefined && this.now() - f.at < this.cooldownFor(f.count);
	}

	/** Consecutive failures recorded for `key`. */
	count(key: K): number {
		return this.failures.get(key)?.count ?? 0;
	}

	/** Record a failure now; returns the new consecutive count. */
	fail(key: K): number {
		const count = this.count(key) + 1;
		this.failures.set(key, { at: this.now(), count });
		return count;
	}

	/** A good load clears the backoff. */
	clear(key: K): void {
		this.failures.delete(key);
	}
}
