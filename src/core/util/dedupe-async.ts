/** Wrap an async function so concurrent callers share the single in-flight promise. */
export function dedupeAsync<A extends unknown[], R>(
	fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
	let inFlight: Promise<R> | null = null;
	return (...args: A): Promise<R> => {
		if (inFlight) return inFlight;
		const p = fn(...args).finally(() => {
			if (inFlight === p) inFlight = null;
		});
		inFlight = p;
		return p;
	};
}
