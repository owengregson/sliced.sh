/**
 * `PANEL_CANCEL_PENDING { tabId }` → drop the scheduled move and abort a running one (the hand
 * releases at once). Idempotent: a tab without an executor or a pending move is a no-op — the
 * Live view shows its own "Skipped" toast once this resolves.
 */

import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { PanelHandlerDeps } from "@service/handlers/panel";

export function registerCancelPendingHandler(
	router: MessageRouter,
	deps: Pick<PanelHandlerDeps, "broadcaster" | "sources">
): void {
	router.on(MSG.PANEL_CANCEL_PENDING, (msg) => {
		deps.sources.executor(msg.tabId)?.cancel();
		deps.broadcaster.notify();
	});
}
