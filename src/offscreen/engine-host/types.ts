// src/offscreen/engine-host/types.ts
/** What one engine host is built from. */

import type { EnginePortMessage } from "@core/constants/messages";
import type { TimerScheduler } from "@core/util/scheduler";
import type { EngineVariant } from "@typedefs/engine";
import type { BootedEngine, NnueSource } from "../stockfish-loader";

export type HostScheduler = TimerScheduler;

/** The store surface the host uses: `get` for `loadNnue`, `delete` to evict a net the engine rejected. */
export interface HostNnueStore extends NnueSource {
	delete?(name: string): Promise<void>;
}

/** What the loader needs from the host for one engine instance. */
export interface BootHooks {
	listen(line: string): void;
	onError(msg: string): void;
	onLoadingNnue(names: string[]): void;
}

export interface EngineHostDeps {
	/** Reviews must fail visibly rather than substitute a weaker network. */
	allowSmallnetFallback?: boolean;
	boot(variant: EngineVariant, hooks: BootHooks): Promise<BootedEngine>;
	nnueStore: HostNnueStore;
	post(msg: EnginePortMessage): void;
	scheduler?: HostScheduler;
}
