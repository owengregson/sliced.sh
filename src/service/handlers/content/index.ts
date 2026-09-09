/**
 * Content → service-worker handlers (§4.3): the boot handshake (`hello`) and
 * the in-page keybinds (`keybind`). The `PORT_NAMES.game` port itself is
 * accepted by `ContentLink` (one registry of per-tab ports, shared by the
 * executor, the focus gate, hand ownership and the session registry), and the
 * `cursor` stream on it is consumed by `HandOwnership`; `cursor.ts` here is its
 * pull side (`cursorProbe`).
 */

import type { MessageRouter } from "@core/messaging/router";
import type { ContentHandlerDeps } from "@service/handlers/content/hello";
import { registerContentHelloHandler } from "@service/handlers/content/hello";
import { registerContentKeybindHandler } from "@service/handlers/content/keybind";

export { probeRealCursor } from "@service/handlers/content/cursor";
export type { ContentHandlerDeps } from "@service/handlers/content/hello";

export function registerContentHandlers(router: MessageRouter, deps: ContentHandlerDeps): void {
	registerContentHelloHandler(router, deps);
	registerContentKeybindHandler(router, deps);
}
