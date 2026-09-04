/** `MSG.OFFSCREEN_ENGINE_STATUS` → the last status the host reported (`DEFAULT_ENGINE_STATUS` before any). */

import { DEFAULT_ENGINE_STATUS } from "@core/constants/defaults";
import { MSG } from "@core/constants/messages";
import type { MessageRouter } from "@core/messaging/router";
import type { EngineStatus } from "@typedefs/engine";

export interface EngineStatusSource {
	status(): EngineStatus | undefined;
}

export function registerEngineStatus(router: MessageRouter, source: EngineStatusSource): void {
	router.on(
		MSG.OFFSCREEN_ENGINE_STATUS,
		() => source.status() ?? { ...DEFAULT_ENGINE_STATUS, nnue: [] }
	);
}
