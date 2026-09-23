/**
 * Typed `Settings` persistence over `LOCAL_KEYS.settings`.
 * `normalizeSettings` is the single validation point: it deep-merges stored
 * data over `DEFAULT_SETTINGS`, clamps numeric ranges with `LIMITS`, replaces
 * invalid enum values with defaults and silently drops unknown keys. The keys in
 * `FORCED_SETTING_VALUES` are overwritten with the forced value on every read: patches for them
 * are still accepted (tests and the harness write them), the normaliser simply wins.
 */

import { chromeLocalGet, chromeLocalSet, onStorageChanged } from "@core/chrome/storage";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import type { Settings } from "@typedefs/settings";
import { normalizeSettings } from "./settings-storage/normalize";
import { isObj, type Obj } from "./settings-storage/readers";

export { normalizeSettings } from "./settings-storage/normalize";

export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends readonly unknown[]
		? T[K]
		: T[K] extends object
			? DeepPartial<T[K]>
			: T[K];
};
export type SettingsPatch = DeepPartial<Settings>;

/** Recursive merge of plain objects; `patch` wins, arrays and primitives replace. */
function deepMerge(base: Obj, patch: Obj): Obj {
	const out: Obj = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		const b = out[k];
		out[k] = isObj(v) && isObj(b) ? deepMerge(b, v) : v;
	}
	return out;
}

export async function getSettings(): Promise<Settings> {
	return normalizeSettings(await chromeLocalGet(LOCAL_KEYS.settings));
}

/**
 * Read-merge-write; resolves with the normalised result that was stored.
 * Not serialised: concurrent callers can lose a patch — the owner (Task 9) must queue writes.
 */
export async function setSettings(patch: SettingsPatch): Promise<Settings> {
	const current = await getSettings();
	const next = normalizeSettings(deepMerge(current as unknown as Obj, patch as Obj));
	await chromeLocalSet(LOCAL_KEYS.settings, next);
	return next;
}

/** Fires with the normalised settings whenever `LOCAL_KEYS.settings` changes; returns the unsubscribe. */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
	return onStorageChanged("local", (changes) => {
		const change = changes[LOCAL_KEYS.settings];
		if (change) cb(normalizeSettings(change.newValue));
	});
}
