// src/offscreen/asset-store/types.ts
/** The shapes the verified asset store is built from and configured with. */

import type { EnginePortMessage } from "@core/constants/messages";
import type { TimerScheduler } from "@core/util/scheduler";

/** The slice of the File System Access API the store uses (structural, so tests can fake it). */
export interface OpfsWritable {
	write(data: Uint8Array): Promise<void>;
	close(): Promise<void>;
}
export interface OpfsFileHandle {
	getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
	createWritable(): Promise<OpfsWritable>;
}
export interface OpfsDirectory {
	getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
	removeEntry(name: string): Promise<void>;
}

export interface AssetFetchResponse {
	ok: boolean;
	body?: ReadableStream<Uint8Array> | null;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** One relayed slice, or the relay's failure; `NnueChunk` and `ModelChunk` both fit. */
export type AssetChunk =
	| { name: string; index: number; total: number; bytes: string }
	| { name: string; error: string };

/** IndexedDB fallback location. */
export interface AssetDbLocation {
	name: string;
	store: string;
	version: number;
}

/** What distinguishes one asset family from another. */
export interface AssetSpec {
	/** Log prefix, e.g. `nnue-store`. */
	label: string;
	/** Error message for a name the store does not serve (checked before any storage access). */
	nameError: string;
	/** Error message after the download attempts failed verification. */
	checksumError: string;
	/** True when `name` is well-formed and known. */
	accepts(name: string): boolean;
	/** Extension-relative path when `name` ships in the package; `undefined` otherwise. */
	bundledPath(name: string): string | undefined;
	/** Optional package decoder. Decoded bytes must match the canonical registry hash. */
	decodeBundled?(name: string, response: AssetFetchResponse): Promise<Uint8Array>;
	/** Expected SHA-256 hex (full digest, or a prefix) `name` must hash to. */
	expectedHash(name: string): string | undefined;
	/** The port message asking the service worker to download `name`. */
	request(name: string): EnginePortMessage;
	/** IndexedDB fallback location. */
	db: AssetDbLocation;
}

export interface AssetStoreDeps {
	/** Posts the download request to the service worker. */
	post: (msg: EnginePortMessage) => void;
	fetch?: (url: string) => Promise<AssetFetchResponse>;
	getUrl?: (path: string) => string;
	/** `null` = OPFS unavailable (IndexedDB only). Default: `navigator.storage.getDirectory`. */
	opfs?: (() => Promise<OpfsDirectory>) | null;
	/** `null` = no IndexedDB. Default: `globalThis.indexedDB`. */
	indexedDb?: IDBFactory | null;
	digest?: (data: Uint8Array) => Promise<ArrayBuffer>;
	onProgress?: (name: string, progress: number) => void;
	/** Timers for the download stall budget; tests pass a fake. */
	scheduler?: TimerScheduler;
	/** Chunk-to-chunk budget before a relayed download is abandoned; default `TIMINGS.assetDownloadStallMs`. */
	stallMs?: number;
	/** Whole-download backstop; default `TIMINGS.assetDownloadTotalMs`. */
	totalMs?: number;
}
