/** `MSG.PANEL_ENGINE_RESTART` → `RemoteEngine.restart()` (resolves when the host is ready again). */

import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";

export interface RestartableEngine {
	restart(): Promise<void>;
}

export function registerEngineRestart(router: MessageRouter, engine: RestartableEngine): void {
	router.on(MSG.PANEL_ENGINE_RESTART, () => engine.restart());
}
