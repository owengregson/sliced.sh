/** License handlers: `PANEL_LOGIN`, `PANEL_LOGOUT`, `PANEL_RECHECK_LICENSE`. */

import type { MessageRouter } from "@core/messaging/router";
import type { ServiceSystems } from "@service/bootstrap";
import { registerLoginHandler } from "@service/handlers/license/login";
import { registerLogoutHandler } from "@service/handlers/license/logout";
import { registerRecheckHandler } from "@service/handlers/license/recheck";

export function registerLicenseHandlers(
	router: MessageRouter,
	systems: Pick<ServiceSystems, "license">
): void {
	registerLoginHandler(router, systems.license);
	registerLogoutHandler(router, systems.license);
	registerRecheckHandler(router, systems.license);
}
