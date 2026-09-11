/**
 * Timing rationale log requests from the Engine view (§8.6): `PANEL_EXPORT_TIMING_LOG` reads the
 * live ring (`TimingLogEntry[]`, oldest first), flushing it before export. Clear updates the
 * same writer and its persistent copy so an alarm cannot restore previously cleared rows.
 */

import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { TimingLogWriter } from "@core/timing/timing-log";
import type { TimingLogEntry } from "@typedefs/timing";

export function registerTimingLogHandlers(router: MessageRouter, writer: TimingLogWriter): void {
	router.on(MSG.PANEL_EXPORT_TIMING_LOG, async (): Promise<TimingLogEntry[]> => {
		await writer.flush();
		return writer.entries().map((entry) => ({ ...entry }));
	});
	router.on(MSG.PANEL_CLEAR_TIMING_LOG, async () => {
		writer.clear();
		await writer.flush();
	});
}
