// test/panel/views/fake-store.ts — a `PanelStore` double for view tests: `emit(snapshot)` pushes to
// subscribers (replayed to late ones), `dispatch` records every command and answers from a queue.
import type { PanelSnapshot } from "@core/constants";
import type { PanelStore } from "@panel/store";
import type { PanelUiState, ViewContext } from "@panel/view";

export interface FakeStore extends PanelStore {
	emit(snapshot: PanelSnapshot): void;
	/** Every command passed to `dispatch`, in order. */
	readonly dispatched: Array<Record<string, unknown>>;
	/** Queue a reply (or a rejection) for the next `dispatch` call. */
	answer(result: unknown, options?: { reject?: boolean }): void;
	/** Leave the next `dispatch` pending until `settle` is called. */
	hold(): { settle: (result: unknown) => void; fail: (error: Error) => void };
}

type Deferred = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export function fakeStore(initial?: PanelSnapshot): FakeStore {
	let snapshot: PanelSnapshot | null = initial ?? null;
	const subs = new Set<(s: PanelSnapshot) => void>();
	const dispatched: Array<Record<string, unknown>> = [];
	const answers: Array<{ result: unknown; reject: boolean } | { deferred: Deferred }> = [];
	let held: Deferred | null = null;
	return {
		get snapshot() {
			return snapshot;
		},
		connected: true,
		dispatched,
		subscribe(cb) {
			subs.add(cb);
			if (snapshot) cb(snapshot);
			return () => void subs.delete(cb);
		},
		onPortMessage: () => () => {},
		dispatch(command) {
			dispatched.push(command as Record<string, unknown>);
			const next = answers.shift();
			if (!next) return Promise.resolve(undefined as never);
			if ("deferred" in next) {
				return new Promise((resolve, reject) => {
					next.deferred.resolve = resolve as (value: unknown) => void;
					next.deferred.reject = reject;
					held = next.deferred;
				}) as never;
			}
			return next.reject
				? Promise.reject(next.result instanceof Error ? next.result : new Error(String(next.result)))
				: (Promise.resolve(next.result) as never);
		},
		refresh() {},
		dispose() {},
		emit(next) {
			snapshot = next;
			for (const cb of [...subs]) cb(next);
		},
		answer(result, options = {}) {
			answers.push({ result, reject: options.reject === true });
		},
		hold() {
			const deferred: Deferred = { resolve: () => {}, reject: () => {} };
			answers.push({ deferred });
			return {
				settle: (result) => (held ?? deferred).resolve(result),
				fail: (error) => (held ?? deferred).reject(error),
			};
		},
	};
}

export function makeUi(patch: Partial<PanelUiState> = {}): PanelUiState {
	return { tab: "game", updateAvailable: false, updateDismissed: false, ...patch };
}

/** A `ViewContext` over `container` with a no-op router (views under test never switch). */
export function makeContext(
	container: HTMLElement,
	store: FakeStore,
	ui: PanelUiState = makeUi()
): ViewContext & { abort(): void } {
	const controller = new AbortController();
	return {
		router: {
			switch: () => Promise.resolve(),
			resolve: () => Promise.resolve(),
			current: null,
		},
		container,
		store,
		snapshot: store.snapshot,
		ui,
		signal: controller.signal,
		abort: () => controller.abort(),
	};
}
