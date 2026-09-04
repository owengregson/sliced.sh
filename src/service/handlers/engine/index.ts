/**
 * Engine-related service-worker handlers (Task 12): panel restart, status
 * query, and the NNUE download relay. `registerEngineHandlers(router, engine)`
 * wires all three against one `RemoteEngine` (or anything with its shape) and
 * returns the detach for the port subscription.
 */

import type { MessageRouter } from "@core/messaging/router";
import { attachNnueDownload, type NnueDownloadDeps, type NnueRelayPort } from "./nnue-download";
import { type RestartableEngine, registerEngineRestart } from "./restart";
import { type EngineStatusSource, registerEngineStatus } from "./status";

export type EngineHandlerTarget = RestartableEngine & EngineStatusSource & NnueRelayPort;

export function registerEngineHandlers(
	router: MessageRouter,
	engine: EngineHandlerTarget,
	deps: NnueDownloadDeps = {}
): () => void {
	registerEngineRestart(router, engine);
	registerEngineStatus(router, engine);
	return attachNnueDownload(engine, deps);
}

export { attachNnueDownload, encodeNnueChunks } from "./nnue-download";
export { registerEngineRestart } from "./restart";
export { registerEngineStatus } from "./status";
