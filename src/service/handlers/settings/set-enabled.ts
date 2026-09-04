/** `PANEL_SET_ENABLED` → `Settings.enabled` through the serialised writer. */

import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import { queueSettingsWrite } from "@service/handlers/settings/write-queue";

export function registerSetEnabledHandler(router: MessageRouter): void {
	router.on(MSG.PANEL_SET_ENABLED, async (msg) => {
		await queueSettingsWrite({ enabled: msg.enabled === true });
	});
}
