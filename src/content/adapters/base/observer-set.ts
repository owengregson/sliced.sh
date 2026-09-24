/**
 * The site adapter's replaceable set of page watchers: every `MutationObserver` and listener a
 * site installs for the current board, torn down together when the board or its containers are
 * replaced and installed afresh (`AdapterBase.reinstallObservers`).
 */

export class ObserverSet {
	private readonly observers: MutationObserver[] = [];
	private readonly disposers: Array<() => void> = [];

	constructor(private readonly observerCtor: () => typeof MutationObserver) {}

	/** Watch `target` (nothing when it is absent); `onRecords` runs for every delivery. */
	observe(
		target: Node | null,
		init: MutationObserverInit,
		onRecords: (records: MutationRecord[]) => void
	): void {
		if (!target) return;
		const Observer = this.observerCtor();
		const observer = new Observer((records: MutationRecord[]) => onRecords(records));
		observer.observe(target, init);
		this.observers.push(observer);
	}

	/** A listener remover that belongs to this set (dropped with it). */
	addDisposer(fn: () => void): void {
		this.disposers.push(fn);
	}

	disconnect(): void {
		for (const o of this.observers) o.disconnect();
		this.observers.length = 0;
		for (const d of this.disposers.splice(0)) d();
	}
}

/** Does any added/removed element of `records` match (or contain) `selector`? */
export function recordsTouch(records: MutationRecord[], selector: string): boolean {
	return records.some((r) =>
		[...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some((n) => {
			if (n.nodeType !== 1) return false;
			const el = n as Element;
			try {
				return el.matches(selector) || el.querySelector(selector) !== null;
			} catch {
				return false;
			}
		})
	);
}
