/** Trailing-edge debounce on the global timers; `cancel()` drops a pending call. */
export function debounced(fn: () => void, ms: number): { trigger(): void; cancel(): void } {
	let handle: ReturnType<typeof setTimeout> | null = null;
	return {
		trigger(): void {
			if (handle !== null) clearTimeout(handle);
			handle = setTimeout(() => {
				handle = null;
				fn();
			}, ms);
		},
		cancel(): void {
			if (handle !== null) clearTimeout(handle);
			handle = null;
		},
	};
}
