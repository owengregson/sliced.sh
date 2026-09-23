/**
 * A set of subscribers. `emit` walks the live set, so a callback that unsubscribes (or subscribes)
 * during delivery is seen the way a `Set` iteration sees it.
 */
export class Emitter<A extends unknown[]> {
	private readonly cbs = new Set<(...args: A) => void>();

	on(cb: (...args: A) => void): () => void {
		this.cbs.add(cb);
		return () => this.cbs.delete(cb);
	}

	emit(...args: A): void {
		for (const cb of this.cbs) cb(...args);
	}

	clear(): void {
		this.cbs.clear();
	}
}
