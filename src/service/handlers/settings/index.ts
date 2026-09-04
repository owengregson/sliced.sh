/** Panel commands that write `Settings` (all through the serialised writer). */

import type { MessageRouter } from "@core/messaging/router";
import { registerSetEnabledHandler } from "@service/handlers/settings/set-enabled";

export { queueSettingsWrite } from "@service/handlers/settings/write-queue";

export function registerSettingsHandlers(router: MessageRouter): void {
	registerSetEnabledHandler(router);
}
