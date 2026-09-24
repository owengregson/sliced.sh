// src/offscreen/shared/single-flight.ts
/**
 * Concurrent requests for one key share one load: the first call starts it, later calls get the
 * same promise until it settles, and a settled load is forgotten so the next call starts afresh.
 */
export class SingleFlight<K, V> {
	private readonly inFlight = new Map<K, Promise<V>>();

	run(key: K, load: (key: K) => Promise<V>): Promise<V> {
		const running = this.inFlight.get(key);
		if (running) return running;
		const p = load(key).finally(() => {
			if (this.inFlight.get(key) === p) this.inFlight.delete(key);
		});
		this.inFlight.set(key, p);
		return p;
	}
}
