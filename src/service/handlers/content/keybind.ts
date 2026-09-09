/**
 * `CONTENT_KEYBIND { action }` — an in-page shortcut the content script
 * captured while the page had focus (§13.4: the page keeps focus, so this is
 * the in-game control path together with `chrome.commands`). The action is
 * routed to the sender tab's `GameSession`; a tab with no session is a no-op.
 */

import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import type { MessageRouter } from "@core/messaging/router";
import { errorMessage } from "@core/util/errors";
import type { ContentHandlerDeps } from "@service/handlers/content/hello";

export function registerContentKeybindHandler(
	router: MessageRouter,
	deps: Pick<ContentHandlerDeps, "session">
): void {
	router.on(MSG.CONTENT_KEYBIND, (msg, sender) => {
		const tabId = sender.tab?.id;
		if (typeof tabId !== "number") return;
		const session = deps.session(tabId);
		if (!session) {
			log.debug("content: keybind with no session on the tab", { tabId, action: msg.action });
			return;
		}
		void session
			.onKeybind(msg.action)
			.catch((error: unknown) =>
				log.warn("content: keybind failed", { action: msg.action, error: errorMessage(error) })
			);
	});
}
