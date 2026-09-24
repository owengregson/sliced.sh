import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";

/** The engine port as seen from the SW (`RemoteEngine` satisfies it). */
export interface EnginePortLike {
	onMessage(cb: (m: EnginePortMessage) => void): () => void;
	post(cmd: EnginePortCommand): void;
}
