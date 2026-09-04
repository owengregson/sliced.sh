/**
 * Promise wrappers over `chrome.storage.{local,session}` and `storage.onChanged`.
 * Typed by the registry key (`LocalStorageSchema` / `SessionStorageSchema`);
 * `get` resolves `null` for a missing value; every callback checks `lastError`.
 */

import type { LocalKey, SessionKey } from "@core/constants/storage-keys";
import type { LocalStorageSchema, SessionStorageSchema } from "@typedefs/storage";

export type StorageAreaName = "local" | "session";
export type StorageChanges = Record<string, chrome.storage.StorageChange>;

function settle(resolve: () => void, reject: (e: Error) => void): void {
	const err = chrome.runtime.lastError;
	if (err) reject(new Error(err.message));
	else resolve();
}

function areaGet<T>(area: chrome.storage.StorageArea, key: string): Promise<T | null> {
	return new Promise((resolve, reject) =>
		area.get(key, (items: Record<string, unknown>) => {
			const err = chrome.runtime.lastError;
			if (err) return reject(new Error(err.message));
			const value = items[key];
			resolve(value === undefined ? null : (value as T));
		})
	);
}

function areaSet(area: chrome.storage.StorageArea, key: string, value: unknown): Promise<void> {
	return new Promise((resolve, reject) => area.set({ [key]: value }, () => settle(resolve, reject)));
}

function areaRemove(area: chrome.storage.StorageArea, keys: string | string[]): Promise<void> {
	return new Promise((resolve, reject) => area.remove(keys, () => settle(resolve, reject)));
}

export function chromeLocalGet<K extends LocalKey>(key: K): Promise<LocalStorageSchema[K] | null> {
	return areaGet<LocalStorageSchema[K]>(chrome.storage.local, key);
}

export function chromeLocalSet<K extends LocalKey>(
	key: K,
	value: LocalStorageSchema[K]
): Promise<void> {
	return areaSet(chrome.storage.local, key, value);
}

export function chromeLocalRemove(keys: LocalKey | LocalKey[]): Promise<void> {
	return areaRemove(chrome.storage.local, keys);
}

export function chromeSessionGet<K extends SessionKey>(
	key: K
): Promise<SessionStorageSchema[K] | null> {
	return areaGet<SessionStorageSchema[K]>(chrome.storage.session, key);
}

export function chromeSessionSet<K extends SessionKey>(
	key: K,
	value: SessionStorageSchema[K]
): Promise<void> {
	return areaSet(chrome.storage.session, key, value);
}

export function chromeSessionRemove(keys: SessionKey | SessionKey[]): Promise<void> {
	return areaRemove(chrome.storage.session, keys);
}

/** Subscribe to `chrome.storage.onChanged` for one area; returns the unsubscribe. */
export function onStorageChanged(
	area: StorageAreaName,
	handler: (changes: StorageChanges) => void
): () => void {
	const listener = (changes: StorageChanges, areaName: string): void => {
		if (areaName === area) handler(changes);
	};
	chrome.storage.onChanged.addListener(listener);
	return () => chrome.storage.onChanged.removeListener(listener);
}
