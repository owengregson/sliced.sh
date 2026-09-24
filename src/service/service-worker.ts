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

import { ALARM_NAMES } from "@core/constants/alarms";
import { log } from "@core/logger";
import { bootstrapServiceSystems } from "@service/bootstrap";
import { createGameStack } from "@service/game-stack";
import { registerLicenseHandlers } from "@service/handlers/license";
import { registerLogHandlers } from "@service/handlers/log";
import { registerPanelHandlers } from "@service/handlers/panel";
import { registerSettingsHandlers } from "@service/handlers/settings";
import { wireServiceLifecycle } from "@service/lifecycle";
import { installLogBridge } from "@service/log-bridge";
import { lateBoundSources, PanelBroadcaster } from "@service/panel-broadcaster";

const systems = bootstrapServiceSystems();
const { router } = systems;

const logBridge = installLogBridge(router);

const lifecycle = wireServiceLifecycle({ systems });

// The panel broadcaster is built first so the game stack can push snapshots into it; its sources
// are the registry the stack then constructs, bound once it exists (`lateBoundSources`).
const panelSources = lateBoundSources(() => systems.license.getState());
const panel = new PanelBroadcaster(panelSources.sources);

const game = createGameStack({ systems, router, broadcaster: panel });
panelSources.bind(game.registry);
systems.sessions = game.registry;
systems.engine = game.engine;

registerLicenseHandlers(router, systems);
registerSettingsHandlers(router);
registerLogHandlers(router, logBridge, game.timingLog);
registerPanelHandlers(router, {
	broadcaster: panel,
	sources: game.registry,
	link: game.link,
	getSettings: game.getSettings,
	settingsKnown: game.settingsKnown,
});

router.install();

systems.sidePanel.install();

// §8.6: the timing-log ring is persisted on the flush alarm (and on game end through the writer).
lifecycle.setAlarmHandler(ALARM_NAMES.timingLogFlush, async () => {
	await game.timingLog.flush();
});

lifecycle.setAlarmHandler(ALARM_NAMES.autoQueue, async () => {
	await game.registry.wakeAutoQueue();
});

// Validation runs at SW startup (§3.6); the alarm handles the 6 h cadence after that.
void systems.license
	.ensure()
	.catch((error: unknown) => log.warn("service-worker: startup license check failed", error));

export { game, lifecycle, logBridge, panel, systems };
