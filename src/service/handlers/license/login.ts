/** `PANEL_LOGIN` → store the key and revalidate; replies with the new `LicenseState`. */

import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { LicenseGate } from "@service/license-gate";

export function registerLoginHandler(router: MessageRouter, license: LicenseGate): void {
	router.on(MSG.PANEL_LOGIN, (msg) =>
		license.login(typeof msg.key === "string" ? msg.key.trim() : "")
	);
}
