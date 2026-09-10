/**
 * `PANEL_PLAY_NOW { tabId }` → the pending move (else the session's current recommendation)
 * plays at once with an instant plan (§8.5 manual path). The reply does not wait for the hand:
 * the outcome reaches the panel through the broadcaster (`lastExecution` + toast). Refused when
 * the hand is not armed — the debugger attaches at arm time only (§13.4) — and while
 * `Settings.enabled` is off (§4.4).
 */

import { PANEL_COMMAND_ERRORS } from "@core/constants/cdp";
import { MSG } from "@core/constants/messages";
import { log } from "@core/logger";
import type { MessageRouter } from "@core/messaging/router";
import { errorMessage } from "@core/util/errors";
import { mayAct, type PanelHandlerDeps } from "@service/handlers/panel";

export function registerPlayNowHandler(
	router: MessageRouter,
	deps: Pick<PanelHandlerDeps, "broadcaster" | "sources" | "getSettings" | "settingsKnown">
): void {
	router.on(MSG.PANEL_PLAY_NOW, (msg) => {
		if (!mayAct(deps)) throw new Error(PANEL_COMMAND_ERRORS.assistantOff);
		const executor = deps.sources.executor(msg.tabId);
		if (!executor) throw new Error(PANEL_COMMAND_ERRORS.noExecutor);
		if (!executor.isArmed()) throw new Error(PANEL_COMMAND_ERRORS.notArmed);
		let run: Promise<unknown>;
		// `pendingMove()` may be a replacement parked behind a cancelled run, which the no-arg
		// `playNow()` ignores: play the reported move explicitly.
		const pending = executor.pendingMove();
		if (pending) run = executor.playNow(pending.rec, pending.rec.plan);
		else {
			const rec = deps.sources.session(msg.tabId)?.recommendation() ?? null;
			if (!rec) throw new Error(PANEL_COMMAND_ERRORS.noRecommendation);
			run = executor.playNow(rec, rec.plan);
		}
		run.catch((error: unknown) =>
			log.warn("panel: playNow failed", { tabId: msg.tabId, error: errorMessage(error) })
		);
		deps.broadcaster.notify();
	});
}
