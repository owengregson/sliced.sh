/** `PANEL_RECHECK_LICENSE` → revalidate the stored key now; replies with the `LicenseState`. */

import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { LicenseGate } from "@service/license-gate";

export function registerRecheckHandler(router: MessageRouter, license: LicenseGate): void {
	router.on(MSG.PANEL_RECHECK_LICENSE, () => license.revalidate());
}
