/**
 * `PANEL_SET_AUTO_MOVE { tabId, armed }` → arm (attach the debugger now — waiting view, never
 * mid-game, §13.4 — and hand the pointer to the virtual hand) or disarm the tab's executor.
 * Arming while the session already holds a recommendation for my turn schedules it for
 * `plan.deadlineMs` (§3.2 step 5) — through `SessionSource.handArmed()`, so the decision and the
 * `MoveContext` stay in the one place that owns them; later recommendations are the session's too.
 * An attach failure — or `Settings.enabled` being off (§4.4) — rejects with the user-facing reason
 * (the panel reverts its toggle); `handArmed()` never rejects, because by then the arm has worked.
 */

import { PANEL_COMMAND_ERRORS } from "@core/constants/cdp";
import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import { mayAct, type PanelHandlerDeps } from "@service/handlers/panel";

export function registerSetAutoMoveHandler(
	router: MessageRouter,
	deps: Pick<PanelHandlerDeps, "broadcaster" | "sources" | "getSettings" | "settingsKnown">
): void {
	router.on(MSG.PANEL_SET_AUTO_MOVE, async (msg) => {
		const executor = deps.sources.executor(msg.tabId);
		if (!executor) throw new Error(PANEL_COMMAND_ERRORS.noExecutor);
		try {
			if (msg.armed !== true) {
				executor.disarm();
				return;
			}
			// §4.4: disarming is always allowed; arming is not, while the assistant is off (or while
			// the stored settings are still unknown).
			if (!mayAct(deps)) throw new Error(PANEL_COMMAND_ERRORS.assistantOff);
			await executor.arm();
			// The *session* acts on a recommendation this arm unblocked (§3.2 step 5). This handler used
			// to do it itself, which meant a third hand-written copy of the double-move gate and —
			// because only the session can build one — an `executor.schedule` with no `MoveContext` at
			// all: no candidates, no legal destinations and no clock, so the §13.2 exploration had
			// nothing to plan from.
			//
			// One deliberate widening comes with that. The old code only ever scheduled a *standing*
			// recommendation (`state === "live:my-turn:recommended"`); `reconsider` also accepts
			// `live:my-turn:analysing`, so arming from the panel while the last search produced nothing
			// now starts a fresh one on our own clock. That is the point of having one mechanism — the
			// arm is a hold being released, whichever hold it was — but it is a behaviour change on
			// this path and not a refactor.
			await deps.sources.session(msg.tabId)?.handArmed();
		} finally {
			deps.broadcaster.notify();
		}
	});
}
