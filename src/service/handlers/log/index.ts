/**
 * Diagnostics handlers for the Engine view (Task 26): the log-stream port, the timing rationale
 * log export/clear and the session reset. `PANEL_ENGINE_DETACH` / `PANEL_ENGINE_REATTACH` are
 * dispatched by the view but owned by the executor (Task 18 / Task 28) — not registered here.
 */

import type { MessageRouter } from "@core/messaging/router";
import { registerSessionResetHandler } from "@service/handlers/log/session-reset";
import { registerLogStreamPort } from "@service/handlers/log/stream";
import { registerTimingLogHandlers } from "@service/handlers/log/timing-log";
import type { LogBridge } from "@service/log-bridge";

/** Returns the unsubscribe for the port acceptance (message handlers live on the router). */
export function registerLogHandlers(router: MessageRouter, bridge: LogBridge): () => void {
	const stopAccepting = registerLogStreamPort(bridge);
	registerTimingLogHandlers(router);
	registerSessionResetHandler(router);
	return stopAccepting;
}
