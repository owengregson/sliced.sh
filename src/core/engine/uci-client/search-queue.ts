/** Priority FIFO of waiting searches: lower rank first, equal ranks in arrival order. */

import type { PendingSearch } from "./pending-search";

export class SearchQueue {
	private queue: PendingSearch[] = [];

	/** Behind every search of the same or a better rank. */
	enqueue(p: PendingSearch): void {
		const at = this.queue.findIndex((q) => q.rank > p.rank);
		if (at < 0) this.queue.push(p);
		else this.queue.splice(at, 0, p);
	}

	shift(): PendingSearch | undefined {
		return this.queue.shift();
	}

	remove(p: PendingSearch): void {
		this.queue = this.queue.filter((q) => q !== p);
	}

	/** Empty the queue and fail every search that was waiting. */
	failAll(): void {
		const queued = this.queue;
		this.queue = [];
		for (const p of queued) p.fail();
	}
}
