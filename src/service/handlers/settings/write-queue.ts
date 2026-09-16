/**
 * Serialised `setSettings` writes. The storage layer's read-modify-write is
 * deliberately unserialised (see `settings-storage.ts`); every SW-side
 * settings write goes through this queue so concurrent panel commands never
 * lose a patch.
 */

import { getSettings, type SettingsPatch, setSettings } from "@core/storage/settings-storage";
import type { Settings } from "@typedefs/settings";

let chain: Promise<unknown> = Promise.resolve();

/** Apply `patch` after every previously queued write; resolves with the stored settings. */
export function queueSettingsWrite(patch: SettingsPatch): Promise<Settings> {
	return enqueue(() => setSettings(patch));
}

/** Compare only after earlier writes settle; a session's cached preference can still be stale. */
export function queueAutoMovePreference(armed: boolean): Promise<Settings> {
	return enqueue(async () => {
		const current = await getSettings();
		return current.automation.autoMove === armed
			? current
			: setSettings({ automation: { autoMove: armed } });
	});
}

function enqueue(write: () => Promise<Settings>): Promise<Settings> {
	const next = chain.then(write);
	chain = next.catch(() => {}); // a failed write must not block later ones
	return next;
}
