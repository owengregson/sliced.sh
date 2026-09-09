/**
 * NNUE download relay (§6.3, Appendix A §5): the `download-relay.ts` preset for Stockfish nets.
 * The service worker fetches the big nets from `URLS.nnueMirror` and streams them back over the
 * engine port as `nnue-chunk`s.
 *
 * CORS: the mirror redirects (`302 → https://data.stockfishchess.org/nn/<name>`)
 * and neither host sends `Access-Control-Allow-Origin`, so a `mode: "cors"`
 * fetch fails. Extension fetches to hosts covered by `host_permissions` bypass
 * CORS instead — both hosts are listed there (`URLS.nnueMirrorHosts`, checked by
 * `test/scripts/manifest-hosts.test.ts`); the fetch uses the default mode and
 * follows the redirect.
 */

import { LIMITS } from "@core/constants/limits";
import type { NnueChunk } from "@core/constants/messages";
import { URLS } from "@core/constants/urls";
import {
	attachDownloadRelay,
	type DownloadRelayDeps,
	type DownloadRelaySpec,
	encodeChunks,
	type RelayFetchResponse,
	type RelayPort,
} from "./download-relay";

export type NnueRelayPort = RelayPort;
export type NnueFetchResponse = RelayFetchResponse;
export type NnueDownloadDeps = DownloadRelayDeps;

const NNUE_RELAY: DownloadRelaySpec = {
	label: "nnue-download",
	requestName: (m) => (m.kind === "nnue-request" ? m.name : undefined),
	urlFor: (name) => `${URLS.nnueMirror}${name}`,
	chunk: (name, index, total, bytes) => ({ kind: "nnue-chunk", name, index, total, bytes }),
	errorChunk: (name, error) => ({ kind: "nnue-chunk", name, error }),
};

/**
 * Yield `bytes` as ordered base64 chunks, one slice encoded per step so only
 * one chunk is materialised at a time (at least one, so an empty net completes).
 */
export function* encodeNnueChunks(
	name: string,
	bytes: Uint8Array,
	chunkBytes: number = LIMITS.nnueChunkBytes
): Generator<NnueChunk, void, undefined> {
	yield* encodeChunks(bytes, chunkBytes, (index, total, b64) => ({
		kind: "nnue-chunk" as const,
		name,
		index,
		total,
		bytes: b64,
	}));
}

/** Answer every `nnue-request` on `port`; returns the detach function. */
export function attachNnueDownload(port: NnueRelayPort, deps: NnueDownloadDeps = {}): () => void {
	return attachDownloadRelay(port, NNUE_RELAY, deps);
}
