/**
 * `PANEL_SET_AUTO_MOVE { tabId, armed }` → arm (attach the debugger now — waiting view, never
 * mid-game, §13.4 — and hand the pointer to the virtual hand) or disarm the tab's executor.
 * Arming while the session already holds a recommendation for my turn schedules it for
 * `plan.deadlineMs` (§3.2 step 5); later recommendations are the session's to schedule. An
 * attach failure rejects with the registry's user-facing reason (the panel reverts its toggle).
 */

import { PANEL_COMMAND_ERRORS } from "@core/constants/cdp";
import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { PanelHandlerDeps } from "@service/handlers/panel";

export function registerSetAutoMoveHandler(
	router: MessageRouter,
	deps: Pick<PanelHandlerDeps, "broadcaster" | "sources">
): void {
	router.on(MSG.PANEL_SET_AUTO_MOVE, async (msg) => {
		const executor = deps.sources.executor(msg.tabId);
		if (!executor) throw new Error(PANEL_COMMAND_ERRORS.noExecutor);
		try {
			if (msg.armed !== true) {
				executor.disarm();
				return;
			}
			await executor.arm();
			const session = deps.sources.session(msg.tabId);
			const rec = session?.recommendation() ?? null;
			if (rec && session?.view().state === "live:my-turn:recommended" && !executor.pendingMove())
				executor.schedule(rec, rec.plan);
		} finally {
			deps.broadcaster.notify();
		}
	});
}
