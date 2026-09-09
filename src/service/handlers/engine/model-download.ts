/**
 * ChessMimic band download relay (Task 34): answers the offscreen store's `model-request` for a
 * registered, non-bundled band by fetching `URLS.chessmimicBandBase + <band>.onnx` and streaming
 * it back as `model-chunk`s (`download-relay.ts`); the store verifies the SHA-256.
 */

import { LIMITS } from "@core/constants/limits";
import type { ModelChunk } from "@core/constants/messages";
import { URLS } from "@core/constants/urls";
import {
	attachDownloadRelay,
	type DownloadRelayDeps,
	type DownloadRelaySpec,
	encodeChunks,
	type RelayPort,
} from "./download-relay";

const MODEL_RELAY: DownloadRelaySpec = {
	label: "model-download",
	requestName: (m) => (m.kind === "model-request" ? m.name : undefined),
	urlFor: (name) => `${URLS.chessmimicBandBase}${name}`,
	chunk: (name, index, total, bytes) => ({ kind: "model-chunk", name, index, total, bytes }),
	errorChunk: (name, error) => ({ kind: "model-chunk", name, error }),
};

export function* encodeModelChunks(
	name: string,
	bytes: Uint8Array,
	chunkBytes: number = LIMITS.nnueChunkBytes
): Generator<ModelChunk, void, undefined> {
	yield* encodeChunks(bytes, chunkBytes, (index, total, b64) => ({
		kind: "model-chunk" as const,
		name,
		index,
		total,
		bytes: b64,
	}));
}

/** Answer every `model-request` on `port`; returns the detach function. */
export function attachModelDownload(port: RelayPort, deps: DownloadRelayDeps = {}): () => void {
	return attachDownloadRelay(port, MODEL_RELAY, deps);
}
