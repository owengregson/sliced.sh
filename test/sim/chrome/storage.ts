// test/sim/chrome/storage.ts
/**
 * `chrome.storage.{local,session}` + `chrome.storage.onChanged`. Values are
 * JSON-cloned on write and read (Chrome serialises them); `onChanged` fires
 * synchronously inside `set` / `remove` / `clear`, before the callback, and
 * fans out to every listener regardless of which context registered it.
 * `failNextWith(message)` makes the next area call fail with `lastError`.
 */

import { type Bus, jsonClone } from "@test/sim/contexts/bus";
import type {
	SimEvent,
	SimulatorOptions,
	StorageAreaName,
	StorageChange,
	StorageChangeListener,
} from "@test/sim/types";

type Items = Record<string, unknown>;
type GetKeys = string | string[] | Items | null | undefined;
type ItemsCallback = (items: Items) => void;

function keyList(keys: GetKeys): string[] | null {
	if (keys === null || keys === undefined) return null;
	if (typeof keys === "string") return [keys];
	if (Array.isArray(keys)) return keys;
	return Object.keys(keys);
}

export function createStorageSubsystem(bus: Bus, options: SimulatorOptions = {}) {
	const data: Record<StorageAreaName, Items> = {
		local: jsonClone({ ...(options.storageLocal ?? {}) }),
		session: jsonClone({ ...(options.storageSession ?? {}) }),
	};
	const onChanged = bus.event<[Record<string, StorageChange>, StorageAreaName]>();
	const areaEvents: Record<StorageAreaName, SimEvent<[Record<string, StorageChange>]>> = {
		local: bus.event(),
		session: bus.event(),
	};
	let pendingError: string | undefined;

	const takeError = (): string | undefined => {
		const err = pendingError;
		pendingError = undefined;
		return err;
	};

	function emit(areaName: StorageAreaName, changes: Record<string, StorageChange>): void {
		if (Object.keys(changes).length === 0) return;
		areaEvents[areaName].fire(jsonClone(changes));
		onChanged.fire(jsonClone(changes), areaName);
	}

	function createArea(areaName: StorageAreaName) {
		const store = (): Items => data[areaName];
		const area = {
			get(keysOrCallback?: GetKeys | ItemsCallback, maybeCallback?: ItemsCallback) {
				const callback = typeof keysOrCallback === "function" ? keysOrCallback : maybeCallback;
				const keys = typeof keysOrCallback === "function" ? null : keysOrCallback;
				const error = takeError();
				const result: Items = {};
				const list = keyList(keys);
				const defaults = keys && typeof keys === "object" && !Array.isArray(keys) ? keys : null;
				for (const k of list ?? Object.keys(store())) {
					if (k in store()) result[k] = jsonClone(store()[k]);
					else if (defaults && k in defaults) result[k] = jsonClone(defaults[k]);
				}
				return bus.settle(callback, error ? {} : result, error);
			},
			set(items: Items, callback?: () => void) {
				const error = takeError();
				if (error) return bus.settle(callback, undefined, error);
				const changes: Record<string, StorageChange> = {};
				for (const [k, v] of Object.entries(items)) {
					if (v === undefined) continue;
					const change: StorageChange = { newValue: jsonClone(v) };
					if (k in store()) change.oldValue = store()[k];
					changes[k] = change;
					store()[k] = jsonClone(v);
				}
				emit(areaName, changes);
				return bus.settle(callback, undefined);
			},
			remove(keys: string | string[], callback?: () => void) {
				const error = takeError();
				if (error) return bus.settle(callback, undefined, error);
				const changes: Record<string, StorageChange> = {};
				for (const k of keyList(keys) ?? []) {
					if (!(k in store())) continue;
					changes[k] = { oldValue: store()[k] };
					delete store()[k];
				}
				emit(areaName, changes);
				return bus.settle(callback, undefined);
			},
			clear(callback?: () => void) {
				const error = takeError();
				if (error) return bus.settle(callback, undefined, error);
				const changes: Record<string, StorageChange> = {};
				for (const k of Object.keys(store())) {
					changes[k] = { oldValue: store()[k] };
					delete store()[k];
				}
				emit(areaName, changes);
				return bus.settle(callback, undefined);
			},
			getBytesInUse(keysOrCallback?: unknown, maybeCallback?: (bytes: number) => void) {
				const callback = typeof keysOrCallback === "function" ? keysOrCallback : maybeCallback;
				const keys = typeof keysOrCallback === "function" ? null : (keysOrCallback as GetKeys);
				let bytes = 0;
				for (const k of keyList(keys) ?? Object.keys(store())) {
					if (k in store()) bytes += k.length + JSON.stringify(store()[k]).length;
				}
				return bus.settle(callback, bytes);
			},
			setAccessLevel(_options: unknown, callback?: () => void) {
				return bus.settle(callback, undefined);
			},
			onChanged: {
				addListener: areaEvents[areaName].addListener,
				removeListener: areaEvents[areaName].removeListener,
				hasListener: areaEvents[areaName].hasListener,
			},
			QUOTA_BYTES: 10_485_760,
		};
		return area;
	}

	const local = createArea("local");
	const session = createArea("session");

	const api = {
		local,
		session,
		onChanged: {
			addListener: (l: StorageChangeListener) => onChanged.addListener(l),
			removeListener: (l: StorageChangeListener) => onChanged.removeListener(l),
			hasListener: (l: StorageChangeListener) => onChanged.hasListener(l),
		},
	};

	return {
		api,
		local,
		session,
		onChanged: api.onChanged,
		/** Raw backing stores, for assertions and seeding. */
		data,
		/** Force the next `get`/`set`/`remove`/`clear` on either area to fail with `lastError`. */
		failNextWith(message: string): void {
			pendingError = message;
		},
		/** Number of `storage.onChanged` listeners (all areas). */
		listenerCount: (): number => onChanged.count(),
		/** Empty both areas without firing `onChanged`. */
		reset(): void {
			for (const area of Object.keys(data) as StorageAreaName[]) {
				for (const k of Object.keys(data[area])) delete data[area][k];
			}
			pendingError = undefined;
		},
	};
}

export type StorageSubsystem = ReturnType<typeof createStorageSubsystem>;
