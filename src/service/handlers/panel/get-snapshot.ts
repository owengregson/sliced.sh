/**
 * `PANEL_GET_SNAPSHOT { windowId? }` → the snapshot for the panel's window (the store's handshake);
 * without a window (not resolved yet) the last-focused window's game tab.
 */

import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { PanelBroadcaster } from "@service/panel-broadcaster";

export function registerGetSnapshotHandler(
	router: MessageRouter,
	broadcaster: Pick<PanelBroadcaster, "snapshotFor">
): void {
	router.on(MSG.PANEL_GET_SNAPSHOT, (msg) =>
		broadcaster.snapshotFor(typeof msg.windowId === "number" ? msg.windowId : null)
	);
}
