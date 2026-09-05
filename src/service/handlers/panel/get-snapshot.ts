/** `PANEL_GET_SNAPSHOT` → the snapshot for the requesting panel's window (the store's handshake). */

import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { PanelBroadcaster } from "@service/panel-broadcaster";

export function registerGetSnapshotHandler(
	router: MessageRouter,
	broadcaster: Pick<PanelBroadcaster, "snapshotFor">
): void {
	router.on(MSG.PANEL_GET_SNAPSHOT, (_msg, sender) => broadcaster.snapshotFor(sender));
}
