/**
 * Generic download relay (§6.3, Appendix A §5). The offscreen document is COEP-restricted, so
 * the service worker fetches big assets (NNUE nets, ChessMimic bands) and streams them back
 * over the engine port in `LIMITS.nnueChunkBytes` slices. Chunks are base64 text:
 * `chrome.runtime` ports JSON-serialise their payloads (no structured clone —
 * crbug.com/248548), so an `ArrayBuffer` would arrive as `{}`.
 *
 * The relay reads `response.body` incrementally and posts each slice as soon as it is complete,
 * so bytes reach the offscreen store *during* the transfer. That is not just a memory win: the
 * store bounds a download by the gap between chunks (`TIMINGS.assetDownloadStallMs`), so if the
 * relay buffered the whole body first, that per-chunk budget would silently become a total
 * budget for the fetch — a 72 MB NNUE below ~5 Mbit/s would be abandoned while progressing
 * perfectly well. Emitting while reading keeps the budget measuring what it claims to measure:
 * silence. A floor remains, one slice per stall budget (~35 kB/s for a 4 MiB chunk in 120 s);
 * it is ~17x lower, not gone.
 *
 * `total` must be exact on the final chunk, because the store completes when it has that many
 * distinct indices. It is taken from `Content-Length` when the server sends one (so the panel's
 * progress bar is accurate from the first chunk); when it does not, non-final chunks advertise
 * `index + 2` — always one more than has arrived, so the store cannot complete early — and the
 * final chunk carries the true count. A response with no readable `body` (a polyfill, a test
 * double) falls back to buffering through `arrayBuffer()`.
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

/** One `read()` of a response body stream. */
export interface RelayStreamReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/**
 * The slice of `Response` the relay uses. `body` is `unknown` rather than a structural stream
 * type on purpose: `ReadableStream.getReader` is overloaded (the BYOB overload wins structural
 * comparison and demands an argument), so a real `Response` would not satisfy a hand-written
 * signature. `readerOf` narrows it at runtime instead, which also lets a fetch double supply a
 * minimal `{ getReader() }` or omit `body` entirely and be buffered through `arrayBuffer()`.
 */
export interface RelayFetchResponse {
	ok: boolean;
	status: number;
	arrayBuffer(): Promise<ArrayBuffer>;
	headers?: { get(name: string): string | null };
	body?: unknown;
}

/** `res.body`'s default reader when it has one, else `undefined` (buffer instead). */
export function readerOf(res: RelayFetchResponse): RelayStreamReader | undefined {
	const body = res.body;
	if (!body || typeof body !== "object") return undefined;
	const getReader = (body as { getReader?: unknown }).getReader;
	if (typeof getReader !== "function") return undefined;
	const reader: unknown = (getReader as (this: unknown) => unknown).call(body);
	if (!reader || typeof reader !== "object") return undefined;
	if (typeof (reader as { read?: unknown }).read !== "function") return undefined;
	return reader as RelayStreamReader;
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

/** FIFO byte queue: `push` what a `read()` gave us, `take` exact slices, O(total) overall. */
class ByteQueue {
	private readonly parts: Uint8Array[] = [];
	private length = 0;

	get size(): number {
		return this.length;
	}

	push(part: Uint8Array): void {
		if (part.length === 0) return;
		this.parts.push(part);
		this.length += part.length;
	}

	/** The first `n` bytes (`n <= size`), removed from the queue. */
	take(n: number): Uint8Array {
		const out = new Uint8Array(n);
		let at = 0;
		while (at < n) {
			const head = this.parts[0];
			if (!head) break;
			const need = n - at;
			if (head.length <= need) {
				out.set(head, at);
				at += head.length;
				this.parts.shift();
			} else {
				out.set(head.subarray(0, need), at);
				this.parts[0] = head.subarray(need);
				at = n;
			}
		}
		this.length -= at;
		return at === n ? out : out.subarray(0, at);
	}

	takeAll(): Uint8Array {
		return this.take(this.length);
	}
}

/** `Content-Length` as a chunk count, or 0 when the server did not send a usable one. */
function expectedChunks(res: RelayFetchResponse, chunkBytes: number): number {
	const header = res.headers?.get("content-length");
	const length = header === undefined || header === null ? Number.NaN : Number(header);
	if (!Number.isFinite(length) || length < 0) return 0;
	return Math.max(1, Math.ceil(length / chunkBytes));
}

/** Answer every request of `spec`'s family on `port`; returns the detach function. */
export function attachDownloadRelay(
	port: RelayPort,
	spec: DownloadRelaySpec,
	deps: DownloadRelayDeps = {}
): () => void {
	const fetchFn = deps.fetch ?? ((url: string) => fetch(url, { redirect: "follow" }));
	const chunkBytes = deps.chunkBytes ?? LIMITS.nnueChunkBytes;

	/**
	 * Post `res.body` as it arrives. A slice is emitted only once *more* than `chunkBytes` is
	 * queued (so it is known not to be the last) or when the stream ends, which is what lets the
	 * final chunk carry the exact count.
	 */
	async function relayStream(
		name: string,
		res: RelayFetchResponse,
		reader: RelayStreamReader
	): Promise<number> {
		const expected = expectedChunks(res, chunkBytes);
		const queue = new ByteQueue();
		let index = 0;
		let sent = 0;
		const emit = (slice: Uint8Array, total: number): void => {
			port.post(spec.chunk(name, index, total, bytesToBase64(slice)));
			index++;
			sent += slice.length;
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (value && value.length > 0) queue.push(value);
			// `>` not `>=`: a slice that exactly empties the queue may still be the last one.
			while (queue.size > chunkBytes) emit(queue.take(chunkBytes), Math.max(expected, index + 2));
			if (done) break;
		}
		emit(queue.takeAll(), index + 1); // the remainder, with the now-known exact count
		return sent;
	}

	async function download(name: string): Promise<void> {
		const url = spec.urlFor(name);
		try {
			log.info(`${spec.label}: fetching`, { name });
			const res = await fetchFn(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const reader = readerOf(res);
			if (reader) {
				const bytes = await relayStream(name, res, reader);
				log.info(`${spec.label}: relayed`, { name, bytes, streamed: true });
				return;
			}
			// No readable body: buffer, then slice. The store's stall budget then covers the whole
			// fetch rather than the gap between chunks, so this path is for doubles and polyfills.
			// Warn, not debug: on a real `Response` this branch should be unreachable, so reaching
			// it in production means the stall budget has quietly become a whole-fetch budget
			// again — the regression this streaming path exists to prevent.
			log.warn(`${spec.label}: response has no readable body; buffering`, { name });
			const bytes = new Uint8Array(await res.arrayBuffer());
			for (const chunk of encodeChunks(bytes, chunkBytes, (i, t, b) => spec.chunk(name, i, t, b)))
				port.post(chunk);
			log.info(`${spec.label}: relayed`, { name, bytes: bytes.length, streamed: false });
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
