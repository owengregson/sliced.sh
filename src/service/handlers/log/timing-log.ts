/**
 * Timing rationale log requests from the Engine view (§8.6): `PANEL_EXPORT_TIMING_LOG` reads the
 * `LOCAL_KEYS.timingLog` ring (`TimingLogEntry[]`, oldest first) and `PANEL_CLEAR_TIMING_LOG`
 * removes it. Task 16 owns the writer; if Task 28's panel handlers take these over, delete here.
 */

import { chromeLocalGet, chromeLocalRemove } from "@core/chrome/storage";
import { MSG } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import type { MessageRouter } from "@core/messaging/router";
import type { TimingLogEntry } from "@typedefs/timing";

export function registerTimingLogHandlers(router: MessageRouter): void {
	router.on(MSG.PANEL_EXPORT_TIMING_LOG, async (): Promise<TimingLogEntry[]> => {
		const entries = await chromeLocalGet(LOCAL_KEYS.timingLog);
		return Array.isArray(entries) ? entries : [];
	});
	router.on(MSG.PANEL_CLEAR_TIMING_LOG, async () => {
		await chromeLocalRemove(LOCAL_KEYS.timingLog);
	});
}
