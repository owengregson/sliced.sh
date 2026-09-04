/**
 * Serialised `setSettings` writes. The storage layer's read-modify-write is
 * deliberately unserialised (see `settings-storage.ts`); every SW-side
 * settings write goes through this queue so concurrent panel commands never
 * lose a patch.
 */

import { type SettingsPatch, setSettings } from "@core/storage/settings-storage";
import type { Settings } from "@typedefs/settings";

let chain: Promise<unknown> = Promise.resolve();

/** Apply `patch` after every previously queued write; resolves with the stored settings. */
export function queueSettingsWrite(patch: SettingsPatch): Promise<Settings> {
	const next = chain.then(() => setSettings(patch));
	chain = next.catch(() => {}); // a failed write must not block later ones
	return next;
}
