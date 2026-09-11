/**
 * `PANEL_PLAY_NOW { tabId }` → the pending move (else the session's current recommendation)
 * plays at once with an instant plan (§8.5 manual path) — through
 * `SessionSource.playNowRequested()`, because the re-plan and the `MoveContext` belong to the
 * session. The reply does not wait for the hand: the outcome reaches the panel through the
 * broadcaster (`lastExecution` + toast). Refused when the hand is not armed — the debugger attaches
 * at arm time only (§13.4) — and while `Settings.enabled` is off (§4.4).
 */

import { PANEL_COMMAND_ERRORS } from "@core/constants/cdp";
import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import { mayAct, type PanelHandlerDeps } from "@service/handlers/panel";

export function registerPlayNowHandler(
	router: MessageRouter,
	deps: Pick<PanelHandlerDeps, "broadcaster" | "sources" | "getSettings" | "settingsKnown">
): void {
	router.on(MSG.PANEL_PLAY_NOW, async (msg) => {
		if (!mayAct(deps)) throw new Error(PANEL_COMMAND_ERRORS.assistantOff);
		const executor = deps.sources.executor(msg.tabId);
		if (!executor) throw new Error(PANEL_COMMAND_ERRORS.noExecutor);
		if (!executor.isArmed()) throw new Error(PANEL_COMMAND_ERRORS.notArmed);
		const session = deps.sources.session(msg.tabId);
		if (!session) throw new Error(PANEL_COMMAND_ERRORS.noExecutor);
		// The *session* plays it (§8.5). This handler used to call `executor.playNow(rec, rec.plan)`
		// itself, which meant no `MoveContext` — no candidates, no legal destinations, no clock, so the
		// hand's §13.2 exploration had nothing to plan from — and no `TimingModel.replan` either. It
		// resolves as soon as the move is handed over, not when the hand finishes: the outcome reaches
		// the panel through the broadcaster.
		if (!(await session.playNowRequested())) throw new Error(PANEL_COMMAND_ERRORS.noRecommendation);
		deps.broadcaster.notify();
	});
}
