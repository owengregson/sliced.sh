/**
 * The debugger pair (§9.7, Task 28 ruling): `PANEL_REATTACH_DEBUGGER { tabId }` re-arms the
 * tab's executor (attach + pointer ownership; "Auto-play back on"), or attaches bare when the
 * tab has no executor — refused while `Settings.enabled` is off (§4.4);
 * `PANEL_DETACH_DEBUGGER { tabId }` disarms and releases the debugger.
 */

import { PANEL_COMMAND_ERRORS } from "@core/constants/cdp";
import { MSG } from "@core/constants/messages";
import { TOAST_KEYS } from "@core/constants/toasts";
import type { MessageRouter } from "@core/messaging/router";
import type { PanelHandlerDeps } from "@service/handlers/panel";

export function registerDebuggerHandlers(
	router: MessageRouter,
	deps: Pick<PanelHandlerDeps, "broadcaster" | "sources" | "getSettings">
): void {
	router.on(MSG.PANEL_REATTACH_DEBUGGER, async (msg) => {
		// §4.4: re-arming is an acting command; releasing the debugger below never is.
		if (!deps.getSettings().enabled) throw new Error(PANEL_COMMAND_ERRORS.assistantOff);
		const executor = deps.sources.executor(msg.tabId);
		const hand = deps.sources.hand;
		try {
			if (executor) await executor.arm();
			else if (hand) await hand.debugger.ensureAttached(msg.tabId);
			else throw new Error(PANEL_COMMAND_ERRORS.noExecutor);
		} finally {
			deps.broadcaster.notify();
		}
		if (executor) void deps.broadcaster.toast("info", { key: TOAST_KEYS.reattached }, msg.tabId);
	});

	router.on(MSG.PANEL_DETACH_DEBUGGER, async (msg) => {
		const executor = deps.sources.executor(msg.tabId);
		const hand = deps.sources.hand;
		if (!executor && !hand) throw new Error(PANEL_COMMAND_ERRORS.noExecutor);
		try {
			executor?.disarm();
			await hand?.debugger.detach(msg.tabId);
		} finally {
			deps.broadcaster.notify();
		}
	});
}
