/** `PANEL_LOGOUT` → clear the key and revalidate; replies with the new `LicenseState`. */

import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { LicenseGate } from "@service/license-gate";

export function registerLogoutHandler(router: MessageRouter, license: LicenseGate): void {
	router.on(MSG.PANEL_LOGOUT, () => license.logout());
}
