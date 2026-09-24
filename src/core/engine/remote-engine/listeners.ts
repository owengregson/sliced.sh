/** A set of callbacks: `add` returns the unsubscribe, `emit` iterates a snapshot. */
export class Listeners<T> {
	private readonly cbs = new Set<(value: T) => void>();

	add(cb: (value: T) => void): () => void {
		this.cbs.add(cb);
		return () => this.cbs.delete(cb);
	}

	/** Callbacks added or removed while emitting do not change this round. */
	emit(value: T): void {
		for (const cb of [...this.cbs]) cb(value);
	}

	clear(): void {
		this.cbs.clear();
	}
}
