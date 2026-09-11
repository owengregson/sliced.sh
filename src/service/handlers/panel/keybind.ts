/** Sidebar shortcuts target the same per-tab session actions as in-page shortcuts. */
import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { PanelHandlerDeps } from "@service/handlers/panel";

export function registerPanelKeybindHandler(
	router: MessageRouter,
	deps: Pick<PanelHandlerDeps, "sources" | "broadcaster">
): void {
	router.on(MSG.PANEL_KEYBIND, async (msg) => {
		await deps.sources.session(msg.tabId)?.onKeybind?.(msg.action);
		deps.broadcaster.notify();
	});
}
