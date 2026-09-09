/**
 * Generic download relay (§6.3, Appendix A §5). The offscreen document is COEP-restricted, so
 * the service worker fetches big assets (NNUE nets, ChessMimic bands) and streams them back
 * over the engine port in `LIMITS.nnueChunkBytes` slices. Chunks are base64 text:
 * `chrome.runtime` ports JSON-serialise their payloads (no structured clone —
 * crbug.com/248548), so an `ArrayBuffer` would arrive as `{}`.
 *
 * Each asset family supplies a `DownloadRelaySpec` (which request to answer, where to fetch,
 * how to shape its chunks); `attachNnueDownload` and `attachModelDownload` are the two presets.
 */

import { LIMITS } from "@core/constants/limits";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import { bytesToBase64 } from "@core/util/base64";

/** The engine port as seen from the SW (`RemoteEngine` satisfies it). */
export interface RelayPort {
	onMessage(cb: (m: EnginePortMessage) => void): () => void;
	post(cmd: EnginePortCommand): void;
}

export interface RelayFetchResponse {
	ok: boolean;
	status: number;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DownloadRelayDeps {
	fetch?: (url: string) => Promise<RelayFetchResponse>;
	chunkBytes?: number;
}

export interface DownloadRelaySpec {
	/** Log prefix, e.g. `nnue-download`. */
	label: string;
	/** The requested asset's name when `m` is this family's request; otherwise `undefined`. */
	requestName(m: EnginePortMessage): string | undefined;
	urlFor(name: string): string;
	chunk(name: string, index: number, total: number, bytes: string): EnginePortCommand;
	errorChunk(name: string, error: string): EnginePortCommand;
}

/**
 * Yield `bytes` as ordered base64 chunks, one slice encoded per step so only one chunk is
 * materialised at a time (at least one, so an empty asset completes).
 */
export function* encodeChunks<T>(
	bytes: Uint8Array,
	chunkBytes: number,
	make: (index: number, total: number, base64: string) => T
): Generator<T, void, undefined> {
	const total = Math.max(1, Math.ceil(bytes.length / chunkBytes));
	for (let index = 0; index < total; index++) {
		const slice = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
		yield make(index, total, bytesToBase64(slice));
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Answer every request of `spec`'s family on `port`; returns the detach function. */
export function attachDownloadRelay(
	port: RelayPort,
	spec: DownloadRelaySpec,
	deps: DownloadRelayDeps = {}
): () => void {
	const fetchFn = deps.fetch ?? ((url: string) => fetch(url, { redirect: "follow" }));
	const chunkBytes = deps.chunkBytes ?? LIMITS.nnueChunkBytes;

	async function download(name: string): Promise<void> {
		const url = spec.urlFor(name);
		try {
			log.info(`${spec.label}: fetching`, { name });
			const res = await fetchFn(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			for (const chunk of encodeChunks(bytes, chunkBytes, (i, t, b) => spec.chunk(name, i, t, b)))
				port.post(chunk);
			log.info(`${spec.label}: relayed`, { name, bytes: bytes.length });
		} catch (error) {
			log.warn(`${spec.label}: failed`, { name, error: errorMessage(error) });
			port.post(spec.errorChunk(name, errorMessage(error)));
		}
	}

	return port.onMessage((m) => {
		const name = spec.requestName(m);
		if (name === undefined) return;
		void download(name);
	});
}
