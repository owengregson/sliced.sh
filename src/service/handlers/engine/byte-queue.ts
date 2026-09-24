/** FIFO byte queue: `push` what a `read()` gave us, `take` exact slices, O(total) overall. */
export class ByteQueue {
	private readonly parts: Uint8Array[] = [];
	private length = 0;

	get size(): number {
		return this.length;
	}

	push(part: Uint8Array): void {
		if (part.length === 0) return;
		this.parts.push(part);
		this.length += part.length;
	}

	/** The first `n` bytes (`n <= size`), removed from the queue. */
	take(n: number): Uint8Array {
		const out = new Uint8Array(n);
		let at = 0;
		while (at < n) {
			const head = this.parts[0];
			if (!head) break;
			const need = n - at;
			if (head.length <= need) {
				out.set(head, at);
				at += head.length;
				this.parts.shift();
			} else {
				out.set(head.subarray(0, need), at);
				this.parts[0] = head.subarray(need);
				at = n;
			}
		}
		this.length -= at;
		return at === n ? out : out.subarray(0, at);
	}

	takeAll(): Uint8Array {
		return this.take(this.length);
	}
}
