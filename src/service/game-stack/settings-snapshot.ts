import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import type { Settings } from "@typedefs/settings";

/**
 * The worker's one fresh `Settings` snapshot, read synchronously by every consumer. Until the
 * first `chrome.storage.local` read answers it is `DEFAULT_SETTINGS`, a placeholder that nothing
 * may act on in either direction (§4.4) — `known()` says when it is the user's.
 */
export class SettingsSnapshot {
	private current: Settings = DEFAULT_SETTINGS;
	private read = false;

	readonly get = (): Settings => this.current;
	readonly known = (): boolean => this.read;

	update(next: Settings): void {
		this.current = next;
		this.read = true;
	}
}
