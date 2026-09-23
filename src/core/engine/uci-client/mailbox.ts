/** Newest-wins mailbox: a slow consumer never sees a backlog of stale frames. */
export class Mailbox<T> implements AsyncIterable<T> {
	private slot: T | undefined;
	private closed = false;
	private wake: (() => void) | undefined;

	put(value: T): void {
		this.slot = value;
		this.signal();
	}

	close(): void {
		this.closed = true;
		this.signal();
	}

	private signal(): void {
		const w = this.wake;
		this.wake = undefined;
		w?.();
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: async (): Promise<IteratorResult<T>> => {
				for (;;) {
					if (this.slot !== undefined) {
						const value = this.slot;
						this.slot = undefined;
						return { value, done: false };
					}
					if (this.closed) return { value: undefined, done: true };
					await new Promise<void>((resolve) => {
						const prev = this.wake;
						this.wake = () => {
							prev?.();
							resolve();
						};
					});
				}
			},
			return: async (): Promise<IteratorResult<T>> => ({ value: undefined, done: true }),
		};
	}
}
