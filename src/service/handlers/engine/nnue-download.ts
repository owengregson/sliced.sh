/**
 * NNUE download relay (§6.3, Appendix A §5). The offscreen document is
 * COEP-restricted, so the service worker fetches the big nets from
 * `URLS.nnueMirror` and streams them back over the engine port in
 * `LIMITS.nnueChunkBytes` slices. Chunks are base64 text: `chrome.runtime`
 * ports JSON-serialise their payloads (no structured clone —
 * crbug.com/248548), so an `ArrayBuffer` would arrive as `{}`.
 */

import { LIMITS } from "@core/constants/limits";
import type { EnginePortCommand, EnginePortMessage, NnueChunk } from "@core/constants/messages";
import { URLS } from "@core/constants/urls";
import { log } from "@core/logger";
import { bytesToBase64 } from "@core/util/base64";

/** The engine port as seen from the SW (`RemoteEngine` satisfies it). */
export interface NnueRelayPort {
	onMessage(cb: (m: EnginePortMessage) => void): () => void;
	post(cmd: EnginePortCommand): void;
}

export interface NnueFetchResponse {
	ok: boolean;
	status: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface NnueDownloadDeps {
	fetch?: (url: string) => Promise<NnueFetchResponse>;
	chunkBytes?: number;
}

/** Split `bytes` into ordered base64 chunks (at least one, so an empty net still completes). */
export function encodeNnueChunks(
	name: string,
	bytes: Uint8Array,
	chunkBytes: number = LIMITS.nnueChunkBytes
): NnueChunk[] {
	const total = Math.max(1, Math.ceil(bytes.length / chunkBytes));
	const chunks: NnueChunk[] = [];
	for (let index = 0; index < total; index++) {
		const slice = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
		chunks.push({ kind: "nnue-chunk", name, index, total, bytes: bytesToBase64(slice) });
	}
	return chunks;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Answer every `nnue-request` on `port`; returns the detach function. */
export function attachNnueDownload(port: NnueRelayPort, deps: NnueDownloadDeps = {}): () => void {
	const fetchFn = deps.fetch ?? ((url: string) => fetch(url, { mode: "cors" }));
	const chunkBytes = deps.chunkBytes ?? LIMITS.nnueChunkBytes;

	async function download(name: string): Promise<void> {
		const url = `${URLS.nnueMirror}${name}`;
		try {
			log.info("nnue-download: fetching", { name });
			const res = await fetchFn(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			for (const chunk of encodeNnueChunks(name, bytes, chunkBytes)) port.post(chunk);
			log.info("nnue-download: relayed", { name, bytes: bytes.length });
		} catch (error) {
			log.warn("nnue-download: failed", { name, error: errorMessage(error) });
			port.post({ kind: "nnue-chunk", name, error: errorMessage(error) });
		}
	}

	return port.onMessage((m) => {
		if (m.kind !== "nnue-request") return;
		void download(m.name);
	});
}
