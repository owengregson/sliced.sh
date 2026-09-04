/**
 * NNUE network store for the offscreen document (§6.3, Appendix A §5).
 *
 * `get(name)` resolves a net's bytes from, in order:
 *   1. the package, when `name` is bundled (`fetch(getURL("assets/engine/" + name))`);
 *   2. the OPFS cache (`navigator.storage.getDirectory()`), or IndexedDB when
 *      OPFS is unavailable — verified against the SHA-256 prefix encoded in the
 *      name (`nn-<sha256[0:12]>.nnue`); a mismatch deletes the copy;
 *   3. a download relayed by the service worker (the offscreen document is
 *      COEP-restricted): `{kind:"nnue-request"}` out, `nnue-chunk`s back over
 *      the same port, reassembled in order with progress callbacks, verified,
 *      then persisted (OPFS, IndexedDB fallback). A checksum mismatch
 *      re-requests once, then fails with `NNUE_CHECKSUM_ERROR`.
 *
 * Chunks carry base64 because runtime ports JSON-serialise their payloads
 * (see `NnueChunk` in the message registry).
 */

import { runtimeGetURL } from "@core/chrome/runtime";
import { ENGINE_DIR } from "@core/constants/engine-files";
import { LIMITS } from "@core/constants/limits";
import type { EnginePortMessage, NnueChunk } from "@core/constants/messages";
import { NNUE_DB } from "@core/constants/storage-keys";
import { log } from "@core/logger";
import { base64ToBytes } from "@core/util/base64";

export const NNUE_CHECKSUM_ERROR = "nnue checksum mismatch";

/** `nn-<12 hex>.nnue` → the 12 hex digits. */
const HASH_START = 3;
const HASH_END = 15;
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

export interface NnueFetchResponse {
	ok: boolean;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface NnueStoreDeps {
	/** Posts `nnue-request` to the service worker. */
	post: (msg: EnginePortMessage) => void;
	fetch?: (url: string) => Promise<NnueFetchResponse>;
	getUrl?: (path: string) => string;
	/** `null` = OPFS unavailable (IndexedDB only). Default: `navigator.storage.getDirectory`. */
	opfs?: (() => Promise<OpfsDirectory>) | null;
	/** `null` = no IndexedDB. Default: `globalThis.indexedDB`. */
	indexedDb?: IDBFactory | null;
	digest?: (data: Uint8Array) => Promise<ArrayBuffer>;
	onProgress?: (name: string, progress: number) => void;
	/** Net names shipped in the package. Default: `[LIMITS.nnueSmallName]`. */
	bundled?: readonly string[];
}

interface Download {
	chunks: Array<Uint8Array | undefined>;
	received: number;
	total: number;
	resolve: (data: Uint8Array) => void;
	reject: (error: Error) => void;
}

export function nnueHashPrefix(name: string): string {
	return name.slice(HASH_START, HASH_END);
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

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
	const req = factory.open(NNUE_DB.name, NNUE_DB.version);
	req.onupgradeneeded = () => {
		if (!req.result.objectStoreNames.contains(NNUE_DB.store))
			req.result.createObjectStore(NNUE_DB.store);
	};
	return request(req);
}

async function withStore<T>(
	factory: IDBFactory,
	mode: IDBTransactionMode,
	fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	const db = await openDb(factory);
	try {
		const tx = db.transaction(NNUE_DB.store, mode);
		const result = await request(fn(tx.objectStore(NNUE_DB.store)));
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
		});
		return result;
	} finally {
		db.close();
	}
}

// ── store ────────────────────────────────────────────────────────────────

export class NnueStore {
	private readonly inFlight = new Map<string, Promise<Uint8Array>>();
	private readonly downloads = new Map<string, Download>();
	private readonly fetchFn: (url: string) => Promise<NnueFetchResponse>;
	private readonly getUrl: (path: string) => string;
	private readonly opfs: (() => Promise<OpfsDirectory>) | null;
	private readonly indexedDb: IDBFactory | null;
	private readonly digest: (data: Uint8Array) => Promise<ArrayBuffer>;
	private readonly bundled: ReadonlySet<string>;

	constructor(private readonly deps: NnueStoreDeps) {
		this.fetchFn = deps.fetch ?? ((url) => fetch(url));
		this.getUrl = deps.getUrl ?? runtimeGetURL;
		this.opfs = deps.opfs === undefined ? defaultOpfs() : deps.opfs;
		this.indexedDb = deps.indexedDb === undefined ? (globalThis.indexedDB ?? null) : deps.indexedDb;
		this.digest = deps.digest ?? defaultDigest;
		this.bundled = new Set(deps.bundled ?? [LIMITS.nnueSmallName]);
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

	/** Route every `nnue-chunk` port message here. */
	handleChunk(msg: NnueChunk): void {
		const d = this.downloads.get(msg.name);
		if (!d) {
			log.debug("nnue-store: chunk for a net nobody requested", { name: msg.name });
			return;
		}
		if ("error" in msg) {
			this.downloads.delete(msg.name);
			d.reject(new Error(msg.error));
			return;
		}
		let bytes: Uint8Array;
		try {
			bytes = base64ToBytes(msg.bytes);
		} catch (error) {
			this.downloads.delete(msg.name);
			d.reject(new Error(`nnue chunk ${msg.index} undecodable: ${errorMessage(error)}`));
			return;
		}
		d.total = msg.total;
		if (d.chunks[msg.index] === undefined) d.received++;
		d.chunks[msg.index] = bytes;
		this.deps.onProgress?.(msg.name, d.total > 0 ? d.received / d.total : 1);
		if (d.received < d.total) return;
		this.downloads.delete(msg.name);
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
				await withStore(this.indexedDb, "readwrite", (s) => s.delete(name));
			} catch {
				// not present / no db
			}
		}
	}

	/** Fail every pending download (the port went away). */
	abortAll(reason: string): void {
		const pending = [...this.downloads.values()];
		this.downloads.clear();
		for (const d of pending) d.reject(new Error(reason));
	}

	private async load(name: string): Promise<Uint8Array> {
		if (this.bundled.has(name)) {
			const bundled = await this.readBundled(name);
			if (bundled) return bundled;
		}
		const cached = await this.readCached(name);
		if (cached) {
			if (await this.verify(cached, name)) return cached;
			log.warn("nnue-store: cached net failed its checksum; deleting", { name });
			await this.delete(name);
		}
		for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
			const data = await this.download(name);
			if (await this.verify(data, name)) {
				await this.persist(name, data);
				return data;
			}
			log.warn("nnue-store: downloaded net failed its checksum", { name, attempt });
		}
		throw new Error(NNUE_CHECKSUM_ERROR);
	}

	private async readBundled(name: string): Promise<Uint8Array | undefined> {
		try {
			const res = await this.fetchFn(this.getUrl(ENGINE_DIR + name));
			if (!res.ok) return undefined;
			return new Uint8Array(await res.arrayBuffer());
		} catch (error) {
			log.warn("nnue-store: bundled net fetch failed", { name, error: errorMessage(error) });
			return undefined;
		}
	}

	private async verify(data: Uint8Array, name: string): Promise<boolean> {
		const expected = nnueHashPrefix(name);
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
				const value = await withStore<unknown>(this.indexedDb, "readonly", (s) => s.get(name));
				if (value instanceof Uint8Array) return value;
				if (value instanceof ArrayBuffer) return new Uint8Array(value);
			} catch (error) {
				log.debug("nnue-store: IndexedDB read failed", { name, error: errorMessage(error) });
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
				log.warn("nnue-store: OPFS write failed; trying IndexedDB", {
					name,
					error: errorMessage(error),
				});
			}
		}
		if (this.indexedDb) {
			try {
				await withStore(this.indexedDb, "readwrite", (s) => s.put(data, name));
				return;
			} catch (error) {
				log.warn("nnue-store: IndexedDB write failed", { name, error: errorMessage(error) });
			}
		}
		log.warn("nnue-store: net not persisted; it will be downloaded again next time", { name });
	}

	private download(name: string): Promise<Uint8Array> {
		return new Promise<Uint8Array>((resolve, reject) => {
			this.downloads.set(name, { chunks: [], received: 0, total: 0, resolve, reject });
			this.deps.post({ kind: "nnue-request", name });
		});
	}
}
