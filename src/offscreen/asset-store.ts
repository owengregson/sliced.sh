/**
 * Verified asset store for the offscreen document (§6.3, Appendix A §5; Task 12 generalised by
 * Task 34 so the ChessMimic bands share it with the NNUE nets). `get(name)` resolves an asset's
 * bytes from, in order:
 *   1. the package, when the spec says `name` is bundled (`fetch(getURL(path))`);
 *   2. the OPFS cache (`navigator.storage.getDirectory()`), or IndexedDB when OPFS is
 *      unavailable — verified against the spec's expected SHA-256 (full digest or prefix); a
 *      mismatch deletes the copy;
 *   3. a download relayed by the service worker (the offscreen document is COEP-restricted):
 *      the spec's request message out, base64 chunks back over the same port
 *      (`handleChunk`), reassembled in order with progress callbacks, verified, then persisted
 *      (OPFS, IndexedDB fallback). A checksum mismatch re-requests once, then fails with the
 *      spec's checksum error.
 *
 * Every relayed download carries a **stall** budget (`TIMINGS.assetDownloadStallMs`), rearmed by
 * each chunk: a service worker that never answers (no handler registered, the relay wedged, the
 * port silently dead) rejects the download instead of leaving a promise pending forever. That
 * matters beyond the wasted memory — `timing-inference.ts` awaits its band candidates serially,
 * so a download that never settles would wedge the head on that band and never reach the
 * substitute. The budget is a stall, not a total, so a slow 72 MB NNUE still finishes.
 *
 * Chunks carry base64 because runtime ports JSON-serialise their payloads (see `NnueChunk`).
 */

import { runtimeGetURL } from "@core/chrome/runtime";
import type { EnginePortMessage } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { base64ToBytes } from "@core/util/base64";
import { DEFAULT_SCHEDULER, type TimerScheduler } from "@core/util/scheduler";

/** Downloads tried before giving up on a checksum mismatch (initial + one re-request). */
const DOWNLOAD_ATTEMPTS = 2;

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
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** One relayed slice, or the relay's failure; `NnueChunk` and `ModelChunk` both fit. */
export type AssetChunk =
	| { name: string; index: number; total: number; bytes: string }
	| { name: string; error: string };

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
	/** Expected SHA-256 hex (full digest, or a prefix) `name` must hash to. */
	expectedHash(name: string): string | undefined;
	/** The port message asking the service worker to download `name`. */
	request(name: string): EnginePortMessage;
	/** IndexedDB fallback location. */
	db: { name: string; store: string; version: number };
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
}

/** Rejection message when the relay went quiet; the caller may retry or substitute. */
export const ASSET_DOWNLOAD_STALLED = "download stalled";

interface Download {
	chunks: Array<Uint8Array | undefined>;
	received: number;
	total: number;
	resolve: (data: Uint8Array) => void;
	reject: (error: Error) => void;
	/** Stall-budget timer handle; cleared whenever the download leaves `downloads`. */
	timer: unknown;
}

const defaultDigest = (data: Uint8Array): Promise<ArrayBuffer> =>
	crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);

export async function sha256Hex(
	data: Uint8Array,
	digest: (data: Uint8Array) => Promise<ArrayBuffer> = defaultDigest
): Promise<string> {
	const hash = new Uint8Array(await digest(data));
	let hex = "";
	for (const b of hash) hex += b.toString(16).padStart(2, "0");
	return hex;
}

function defaultOpfs(): (() => Promise<OpfsDirectory>) | null {
	const storage = globalThis.navigator?.storage;
	if (!storage || typeof storage.getDirectory !== "function") return null;
	return () => storage.getDirectory() as Promise<OpfsDirectory>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── IndexedDB fallback ────────────────────────────────────────────────────

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

function openDb(factory: IDBFactory, db: AssetSpec["db"]): Promise<IDBDatabase> {
	const req = factory.open(db.name, db.version);
	req.onupgradeneeded = () => {
		if (!req.result.objectStoreNames.contains(db.store)) req.result.createObjectStore(db.store);
	};
	return request(req);
}

async function withStore<T>(
	factory: IDBFactory,
	db: AssetSpec["db"],
	mode: IDBTransactionMode,
	fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	const handle = await openDb(factory, db);
	try {
		const tx = handle.transaction(db.store, mode);
		const result = await request(fn(tx.objectStore(db.store)));
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
		});
		return result;
	} finally {
		handle.close();
	}
}

// ── store ────────────────────────────────────────────────────────────────

export class AssetStore {
	private readonly inFlight = new Map<string, Promise<Uint8Array>>();
	private readonly downloads = new Map<string, Download>();
	private readonly fetchFn: (url: string) => Promise<AssetFetchResponse>;
	private readonly getUrl: (path: string) => string;
	private readonly opfs: (() => Promise<OpfsDirectory>) | null;
	private readonly indexedDb: IDBFactory | null;
	private readonly digest: (data: Uint8Array) => Promise<ArrayBuffer>;
	private readonly sched: TimerScheduler;
	private readonly stallMs: number;

	constructor(
		protected readonly spec: AssetSpec,
		private readonly deps: AssetStoreDeps
	) {
		this.fetchFn = deps.fetch ?? ((url) => fetch(url));
		this.getUrl = deps.getUrl ?? runtimeGetURL;
		this.opfs = deps.opfs === undefined ? defaultOpfs() : deps.opfs;
		this.indexedDb = deps.indexedDb === undefined ? (globalThis.indexedDB ?? null) : deps.indexedDb;
		this.digest = deps.digest ?? defaultDigest;
		this.sched = deps.scheduler ?? DEFAULT_SCHEDULER;
		this.stallMs = deps.stallMs ?? TIMINGS.assetDownloadStallMs;
	}

	/** Drop `name`'s download and stop its stall timer; returns the entry if there was one. */
	private takeDownload(name: string): Download | undefined {
		const d = this.downloads.get(name);
		if (!d) return undefined;
		this.downloads.delete(name);
		this.sched.clearTimeout(d.timer);
		return d;
	}

	/** Bytes of `name`, verified; concurrent calls for one name share the work. */
	get(name: string): Promise<Uint8Array> {
		const running = this.inFlight.get(name);
		if (running) return running;
		const p = this.load(name).finally(() => {
			if (this.inFlight.get(name) === p) this.inFlight.delete(name);
		});
		this.inFlight.set(name, p);
		return p;
	}

	/** Route every relayed chunk of this family here. */
	handleChunk(msg: AssetChunk): void {
		const d = this.downloads.get(msg.name);
		if (!d) {
			log.debug(`${this.spec.label}: chunk for an asset nobody requested`, { name: msg.name });
			return;
		}
		if ("error" in msg) {
			this.takeDownload(msg.name);
			d.reject(new Error(msg.error));
			return;
		}
		let bytes: Uint8Array;
		try {
			bytes = base64ToBytes(msg.bytes);
		} catch (error) {
			this.takeDownload(msg.name);
			d.reject(new Error(`${this.spec.label} chunk ${msg.index} undecodable: ${errorMessage(error)}`));
			return;
		}
		this.rearmStall(msg.name, d);
		d.total = msg.total;
		if (d.chunks[msg.index] === undefined) d.received++;
		d.chunks[msg.index] = bytes;
		this.deps.onProgress?.(msg.name, d.total > 0 ? d.received / d.total : 1);
		if (d.received < d.total) return;
		this.takeDownload(msg.name);
		let length = 0;
		for (const c of d.chunks) length += c?.length ?? 0;
		const out = new Uint8Array(length);
		let at = 0;
		for (const c of d.chunks) {
			if (!c) continue;
			out.set(c, at);
			at += c.length;
		}
		d.resolve(out);
	}

	/** Remove a cached copy (OPFS and IndexedDB). */
	async delete(name: string): Promise<void> {
		if (this.opfs) {
			try {
				await (await this.opfs()).removeEntry(name);
			} catch {
				// not present
			}
		}
		if (this.indexedDb) {
			try {
				await withStore(this.indexedDb, this.spec.db, "readwrite", (s) => s.delete(name));
			} catch {
				// not present / no db
			}
		}
	}

	/** Fail every pending download (the port went away). */
	abortAll(reason: string): void {
		const pending = [...this.downloads.values()];
		this.downloads.clear();
		for (const d of pending) {
			this.sched.clearTimeout(d.timer);
			d.reject(new Error(reason));
		}
	}

	private async load(name: string): Promise<Uint8Array> {
		if (!this.spec.accepts(name)) throw new Error(`${this.spec.nameError}: ${name}`);
		const bundledPath = this.spec.bundledPath(name);
		if (bundledPath !== undefined) {
			const bundled = await this.readBundled(name, bundledPath);
			if (bundled) return bundled;
		}
		const cached = await this.readCached(name);
		if (cached) {
			if (await this.verify(cached, name)) return cached;
			log.warn(`${this.spec.label}: cached copy failed its checksum; deleting`, { name });
			await this.delete(name);
		}
		for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
			const data = await this.download(name);
			if (await this.verify(data, name)) {
				await this.persist(name, data);
				return data;
			}
			log.warn(`${this.spec.label}: download failed its checksum`, { name, attempt });
		}
		throw new Error(this.spec.checksumError);
	}

	private async readBundled(name: string, path: string): Promise<Uint8Array | undefined> {
		try {
			const res = await this.fetchFn(this.getUrl(path));
			if (!res.ok) return undefined;
			return new Uint8Array(await res.arrayBuffer());
		} catch (error) {
			log.warn(`${this.spec.label}: bundled fetch failed`, { name, error: errorMessage(error) });
			return undefined;
		}
	}

	private async verify(data: Uint8Array, name: string): Promise<boolean> {
		const expected = this.spec.expectedHash(name);
		if (!expected) return false;
		return (await sha256Hex(data, this.digest)).startsWith(expected);
	}

	private async readCached(name: string): Promise<Uint8Array | undefined> {
		if (this.opfs) {
			try {
				const dir = await this.opfs();
				const file = await (await dir.getFileHandle(name)).getFile();
				return new Uint8Array(await file.arrayBuffer());
			} catch {
				// not cached in OPFS
			}
		}
		if (this.indexedDb) {
			try {
				const value = await withStore<unknown>(this.indexedDb, this.spec.db, "readonly", (s) =>
					s.get(name)
				);
				if (value instanceof Uint8Array) return value;
				if (value instanceof ArrayBuffer) return new Uint8Array(value);
			} catch (error) {
				log.debug(`${this.spec.label}: IndexedDB read failed`, { name, error: errorMessage(error) });
			}
		}
		return undefined;
	}

	private async persist(name: string, data: Uint8Array): Promise<void> {
		if (this.opfs) {
			try {
				const dir = await this.opfs();
				const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
				await writable.write(data);
				await writable.close();
				return;
			} catch (error) {
				log.warn(`${this.spec.label}: OPFS write failed; trying IndexedDB`, {
					name,
					error: errorMessage(error),
				});
			}
		}
		if (this.indexedDb) {
			try {
				await withStore(this.indexedDb, this.spec.db, "readwrite", (s) => s.put(data, name));
				return;
			} catch (error) {
				log.warn(`${this.spec.label}: IndexedDB write failed`, { name, error: errorMessage(error) });
			}
		}
		log.warn(`${this.spec.label}: asset not persisted; it will be downloaded again next time`, {
			name,
		});
	}

	/** (Re)start `name`'s stall budget: no chunk within `stallMs` rejects the download. */
	private rearmStall(name: string, d: Download): void {
		this.sched.clearTimeout(d.timer);
		d.timer = this.sched.setTimeout(() => {
			if (this.downloads.get(name) !== d) return;
			this.downloads.delete(name);
			log.warn(`${this.spec.label}: no chunk within the stall budget; abandoning`, {
				name,
				stallMs: this.stallMs,
				received: d.received,
				total: d.total,
			});
			d.reject(new Error(`${ASSET_DOWNLOAD_STALLED}: ${name}`));
		}, this.stallMs);
	}

	private download(name: string): Promise<Uint8Array> {
		return new Promise<Uint8Array>((resolve, reject) => {
			const d: Download = { chunks: [], received: 0, total: 0, resolve, reject, timer: undefined };
			this.downloads.set(name, d);
			this.rearmStall(name, d);
			this.deps.post(this.spec.request(name));
		});
	}
}
