/**
 * Service worker entry point (bundle root, Appendix H.5 style).
 *
 * Pure orchestration: install the log bridge, bootstrap the singleton
 * systems, wire the Chrome lifecycle, register every domain handler on the
 * message router, install the router, then the side-panel policy. Every
 * listener is registered synchronously at top level (MV3 rule: listeners
 * added later than the first turn miss the events that woke the worker);
 * the async work runs inside the handlers.
 */

import { log } from "@core/logger";
import { bootstrapServiceSystems } from "@service/bootstrap";
import { registerLicenseHandlers } from "@service/handlers/license";
import { registerLogHandlers } from "@service/handlers/log";
import { registerSettingsHandlers } from "@service/handlers/settings";
import { wireServiceLifecycle } from "@service/lifecycle";
import { installLogBridge } from "@service/log-bridge";

const systems = bootstrapServiceSystems();
const { router } = systems;

const logBridge = installLogBridge(router);

const lifecycle = wireServiceLifecycle({ systems });

registerLicenseHandlers(router, systems);
registerSettingsHandlers(router);
registerLogHandlers(router, logBridge);

router.install();

systems.sidePanel.install();

// Validation runs at SW startup (§3.6); the alarm handles the 6 h cadence after that.
void systems.license
	.ensure()
	.catch((error: unknown) => log.warn("service-worker: startup license check failed", error));

export { lifecycle, logBridge, systems };
