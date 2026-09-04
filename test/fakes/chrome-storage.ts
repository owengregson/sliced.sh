// test/fakes/chrome-storage.ts
/**
 * Minimal in-memory `chrome.storage.{local,session}` + `chrome.storage.onChanged`
 * fake for Task 3's storage tests. Callback-style (matching the wrappers in
 * `src/core/chrome/storage.ts`); Task 8's simulator replaces it.
 */

type Items = Record<string, unknown>;
type Change = { oldValue?: unknown; newValue?: unknown };
type ChangeListener = (changes: Record<string, Change>, areaName: string) => void;
type Keys = string | string[] | Items | null | undefined;

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

function keyList(keys: Keys): string[] | null {
	if (keys === null || keys === undefined) return null;
	if (typeof keys === "string") return [keys];
	if (Array.isArray(keys)) return keys;
	return Object.keys(keys);
}

export interface FakeChromeStorage {
	/** Raw backing stores, for assertions and seeding. */
	data: { local: Items; session: Items };
	/** Force the next callback to see `chrome.runtime.lastError`. */
	failNextWith(message: string): void;
	reset(): void;
}

export function installFakeChromeStorage(): FakeChromeStorage {
	const data: FakeChromeStorage["data"] = { local: {}, session: {} };
	const listeners = new Set<ChangeListener>();
	let pendingError: string | null = null;
	const runtime: { lastError: { message: string } | undefined } = { lastError: undefined };

	function invoke<T>(cb: ((v: T) => void) | undefined, value: T): void {
		if (!cb) return;
		if (pendingError !== null) {
			runtime.lastError = { message: pendingError };
			pendingError = null;
		}
		try {
			cb(value);
		} finally {
			runtime.lastError = undefined;
		}
	}

	function emit(areaName: "local" | "session", changes: Record<string, Change>): void {
		if (Object.keys(changes).length === 0) return;
		for (const l of listeners) l(clone(changes), areaName);
	}

	function area(areaName: "local" | "session") {
		const store = data[areaName];
		return {
			get(keysOrCb: Keys | ((items: Items) => void), maybeCb?: (items: Items) => void) {
				const cb = typeof keysOrCb === "function" ? keysOrCb : maybeCb;
				const list = keyList(typeof keysOrCb === "function" ? null : keysOrCb);
				const out: Items = {};
				for (const k of list ?? Object.keys(store)) if (k in store) out[k] = clone(store[k]);
				invoke(cb, out);
			},
			set(items: Items, cb?: () => void) {
				const changes: Record<string, Change> = {};
				for (const [k, v] of Object.entries(items)) {
					changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
					store[k] = clone(v);
				}
				invoke(cb, undefined);
				emit(areaName, changes);
			},
			remove(keys: string | string[], cb?: () => void) {
				const changes: Record<string, Change> = {};
				for (const k of keyList(keys) ?? []) {
					if (!(k in store)) continue;
					changes[k] = { oldValue: clone(store[k]) };
					delete store[k];
				}
				invoke(cb, undefined);
				emit(areaName, changes);
			},
			clear(cb?: () => void) {
				for (const k of Object.keys(store)) delete store[k];
				invoke(cb, undefined);
			},
		};
	}

	const chromeFake = {
		runtime,
		storage: {
			local: area("local"),
			session: area("session"),
			onChanged: {
				addListener: (l: ChangeListener) => void listeners.add(l),
				removeListener: (l: ChangeListener) => void listeners.delete(l),
				hasListener: (l: ChangeListener) => listeners.has(l),
			},
		},
	};
	(globalThis as Record<string, unknown>).chrome = chromeFake;

	return {
		data,
		failNextWith: (message) => {
			pendingError = message;
		},
		reset: () => {
			data.local = {};
			data.session = {};
			listeners.clear();
			pendingError = null;
			chromeFake.storage.local = area("local");
			chromeFake.storage.session = area("session");
		},
	};
}
