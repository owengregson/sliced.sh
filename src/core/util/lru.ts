/** Insertion-ordered Map LRU: `get`/`set` move an entry to the front; the oldest is evicted at capacity. */
export class LruCache<K, V> {
	private readonly map = new Map<K, V>();

	constructor(private readonly capacity: number) {
		if (!(capacity > 0)) throw new RangeError("LruCache: capacity must be positive");
	}

	get size(): number {
		return this.map.size;
	}

	get(key: K): V | undefined {
		if (!this.map.has(key)) return undefined;
		const value = this.map.get(key) as V;
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	set(key: K, value: V): this {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.capacity) {
			const oldest = this.map.keys().next();
			if (!oldest.done) this.map.delete(oldest.value);
		}
		return this;
	}

	/** Read without refreshing recency. */
	peek(key: K): V | undefined {
		return this.map.get(key);
	}

	/** Does not refresh recency. */
	has(key: K): boolean {
		return this.map.has(key);
	}

	delete(key: K): boolean {
		return this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}

	/** Entries from least to most recently used. */
	entries(): IterableIterator<[K, V]> {
		return this.map.entries();
	}
}
