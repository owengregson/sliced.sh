/**
 * `PANEL_RESET_SESSION` (Appendix F §4.7 "Reset session"): zero `LOCAL_KEYS.sessionStats`. The
 * live session registry (Task 30) may extend this to reset per-game state; storage is the only
 * thing the panel's session line reads today (`PanelSnapshot.stats`).
 */

import { chromeLocalSet } from "@core/chrome/storage";
import { MSG } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import type { MessageRouter } from "@core/messaging/router";
import type { SessionStats } from "@typedefs/game";

export const EMPTY_SESSION_STATS: Readonly<SessionStats> = Object.freeze({
	games: 0,
	moves: 0,
	avgThinkMs: 0,
});

export function registerSessionResetHandler(router: MessageRouter): void {
	router.on(MSG.PANEL_RESET_SESSION, async () => {
		await chromeLocalSet(LOCAL_KEYS.sessionStats, { ...EMPTY_SESSION_STATS });
	});
}
