/**
 * `CONTENT_HELLO` — the content script's boot handshake (§4.3). It asks for the
 * keybinds it should install and whether the extension is enabled at all; the
 * reply is the only way a freshly injected content script learns them before
 * the game port's `keybinds` command arrives.
 *
 * The port-side `hello` (site / page kind / adapter version) is a different
 * message: it reaches the session registry over `PORT_NAMES.game`, which is
 * what opens a `GameSession` for the tab.
 */

import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import type { MessageRouter } from "@core/messaging/router";
import type { Settings } from "@typedefs/settings";

export interface ContentHandlerDeps {
	getSettings(): Settings;
	/** The session on `tabId`, if one is open. */
	session(tabId: number): { onKeybind(action: string): Promise<void> } | null;
	/** Opens (or returns) the session for a tab whose content script is connected. */
	ensure?: ((tabId: number) => void) | undefined;
}

export function registerContentHelloHandler(
	router: MessageRouter,
	deps: Pick<ContentHandlerDeps, "getSettings" | "ensure">
): void {
	router.on(MSG.CONTENT_HELLO, (_msg, sender) => {
		const settings = deps.getSettings();
		const tabId = sender.tab?.id;
		if (typeof tabId === "number") {
			deps.ensure?.(tabId);
			log.debug("content: hello", { tabId });
		}
		return { keybinds: settings.keybinds, enabled: settings.enabled };
	});
}
