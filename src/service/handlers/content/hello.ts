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
import type { ContentHandlerDeps } from "@service/handlers/content/deps";

export type { ContentHandlerDeps } from "@service/handlers/content/deps";

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
