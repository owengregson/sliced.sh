/**
 * ChessMimic band download relay (Task 34): answers the offscreen store's `model-request` for a
 * registered, non-bundled band by fetching `URLS.chessmimicBandBase + <band>.onnx` and streaming
 * it back as `model-chunk`s (`download-relay.ts`); the store verifies the SHA-256.
 *
 * **Not wired yet.** `registerEngineHandlers` attaches only `attachNnueDownload`, because every
 * registered band currently ships in the package (`CHESSMIMIC_BAND_FILES[...].bundled`). Enabling
 * an on-demand band means calling this from `registerEngineHandlers`, adding the band host to
 * `manifest.json`'s `host_permissions` (`test/scripts/manifest-hosts.test.ts` enforces the pair)
 * and hosting the file — see `docs/models.md` §6. Until then an unanswered `model-request` is
 * bounded by the store's stall budget rather than fatal.
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
