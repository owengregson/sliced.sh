/** What the content → service-worker handlers read. */

import type { Settings } from "@typedefs/settings";

export interface ContentHandlerDeps {
	getSettings(): Settings;
	/** The session on `tabId`, if one is open. */
	session(tabId: number): { onKeybind(action: string): Promise<void> } | null;
	/** Opens (or returns) the session for a tab whose content script is connected. */
	ensure?: ((tabId: number) => void) | undefined;
}
