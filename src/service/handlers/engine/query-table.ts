/**
 * The pending side of a request/reply exchange over the engine port (the timing and policy
 * inference ports): each query waits under its own id with its own expiry and honours its
 * caller's abort signal, so a host that never answers cannot leak one closure per move.
 */

import type { TimerScheduler } from "@core/util/scheduler";

interface PendingQuery<R> {
	resolve: (r: R | null) => void;
	timer: unknown;
	cleanup: () => void;
}

export interface QueryTable<R> {
	/**
	 * Wait for query `id`: `send` posts it once the waiter is in place. Resolves `null` when the
	 * expiry passes first (after `onExpired`) or when `signal` aborts.
	 */
	ask(
		id: string,
		expiresMs: number,
		signal: AbortSignal | undefined,
		onExpired: () => void,
		send: () => void
	): Promise<R | null>;
	/** Remove `id` and stop its expiry; returns its resolver if it was still waiting. */
	take(id: string): ((r: R | null) => void) | undefined;
	size(): number;
	/** Settle every waiting query with `null`. */
	settleAll(): void;
}

export function createQueryTable<R>(sched: TimerScheduler): QueryTable<R> {
	const pending = new Map<string, PendingQuery<R>>();

	function take(id: string): PendingQuery<R> | undefined {
		const q = pending.get(id);
		if (!q) return undefined;
		pending.delete(id);
		sched.clearTimeout(q.timer);
		q.cleanup();
		return q;
	}

	return {
		ask(id, expiresMs, signal, onExpired, send) {
			return new Promise((resolve) => {
				const abort = () => take(id)?.resolve(null);
				const timer = sched.setTimeout(() => {
					if (!take(id)) return;
					onExpired();
					resolve(null);
				}, expiresMs);
				pending.set(id, {
					resolve,
					timer,
					cleanup: () => signal?.removeEventListener("abort", abort),
				});
				signal?.addEventListener("abort", abort, { once: true });
				send();
			});
		},
		take: (id) => take(id)?.resolve,
		size: () => pending.size,
		settleAll() {
			const waiting = [...pending.values()];
			pending.clear();
			for (const q of waiting) {
				sched.clearTimeout(q.timer);
				q.cleanup();
				q.resolve(null);
			}
		},
	};
}
