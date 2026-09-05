/**
 * Panel command handlers (Task 28): the request/response side of the panel ↔ SW contract
 * (§4.3) that acts on the game tab's session and executor — `PANEL_GET_SNAPSHOT`,
 * `PANEL_SET_AUTO_MOVE`, `PANEL_PLAY_NOW`, `PANEL_CANCEL_PENDING`, `PANEL_PREVIEW_LINE` and the
 * debugger pair. The license (`handlers/license`), settings (`handlers/settings`), engine
 * (`handlers/engine`) and diagnostics (`handlers/log`) commands keep their own registrations.
 * Every state change ends in `broadcaster.notify()` so the panel's next snapshot reflects it.
 */

import type { GamePortCommand } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import { registerCancelPendingHandler } from "@service/handlers/panel/cancel-pending";
import { registerDebuggerHandlers } from "@service/handlers/panel/debugger";
import { registerGetSnapshotHandler } from "@service/handlers/panel/get-snapshot";
import { registerPlayNowHandler } from "@service/handlers/panel/play-now";
import { registerPreviewLineHandler } from "@service/handlers/panel/preview-line";
import { registerSetAutoMoveHandler } from "@service/handlers/panel/set-auto-move";
import type { PanelBroadcaster, SnapshotSources } from "@service/panel-broadcaster";

/** The slice of `ContentLink` the preview command needs. */
export interface HighlightLink {
	post(tabId: number, cmd: GamePortCommand): boolean;
}

export interface PanelHandlerDeps {
	broadcaster: PanelBroadcaster;
	sources: SnapshotSources;
	/** `null` until Task 30 constructs the content link (previews are then no-ops). */
	link: HighlightLink | null;
}

export function registerPanelHandlers(router: MessageRouter, deps: PanelHandlerDeps): void {
	registerGetSnapshotHandler(router, deps.broadcaster);
	registerSetAutoMoveHandler(router, deps);
	registerPlayNowHandler(router, deps);
	registerCancelPendingHandler(router, deps);
	registerPreviewLineHandler(router, deps);
	registerDebuggerHandlers(router, deps);
}
