// src/offscreen/asset-store/cache.ts
/**
 * The persistent copy of an asset family: the OPFS directory
 * (`navigator.storage.getDirectory()`), with IndexedDB as the fallback when OPFS is unavailable
 * or a write to it fails. Reads return what is stored, unverified — the store checks the hash —
 * and every failure is absorbed: a missing cache only means a download.
 */

import { log } from "@core/logger";
import { errorMessage } from "../shared/errors";
import { withStore } from "./idb";
import type { AssetDbLocation, OpfsDirectory } from "./types";

export function defaultOpfs(): (() => Promise<OpfsDirectory>) | null {
	const storage = globalThis.navigator?.storage;
	if (!storage || typeof storage.getDirectory !== "function") return null;
	return () => storage.getDirectory() as Promise<OpfsDirectory>;
}

export interface AssetCacheDeps {
	/** Log prefix, e.g. `nnue-store`. */
	label: string;
	/** `null` = OPFS unavailable. */
	opfs: (() => Promise<OpfsDirectory>) | null;
	/** `null` = no IndexedDB. */
	indexedDb: IDBFactory | null;
	db: AssetDbLocation;
}

export class AssetCache {
	constructor(private readonly deps: AssetCacheDeps) {}

	/** The cached bytes of `name` (OPFS first, then IndexedDB), or `undefined`. */
	async read(name: string): Promise<Uint8Array | undefined> {
		const { opfs, indexedDb, db, label } = this.deps;
		if (opfs) {
			try {
				const dir = await opfs();
				const file = await (await dir.getFileHandle(name)).getFile();
				return new Uint8Array(await file.arrayBuffer());
			} catch {
				// not cached in OPFS
			}
		}
		if (indexedDb) {
			try {
				const value = await withStore<unknown>(indexedDb, db, "readonly", (s) => s.get(name));
				if (value instanceof Uint8Array) return value;
				if (value instanceof ArrayBuffer) return new Uint8Array(value);
			} catch (error) {
				log.debug(`${label}: IndexedDB read failed`, { name, error: errorMessage(error) });
			}
		}
		return undefined;
	}

	/** Persist `data` as `name`: OPFS, else IndexedDB, else a warning (it downloads next time). */
	async write(name: string, data: Uint8Array): Promise<void> {
		const { opfs, indexedDb, db, label } = this.deps;
		if (opfs) {
			try {
				const dir = await opfs();
				const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
				await writable.write(data);
				await writable.close();
				return;
			} catch (error) {
				log.warn(`${label}: OPFS write failed; trying IndexedDB`, {
					name,
					error: errorMessage(error),
				});
			}
		}
		if (indexedDb) {
			try {
				await withStore(indexedDb, db, "readwrite", (s) => s.put(data, name));
				return;
			} catch (error) {
				log.warn(`${label}: IndexedDB write failed`, { name, error: errorMessage(error) });
			}
		}
		log.warn(`${label}: asset not persisted; it will be downloaded again next time`, {
			name,
		});
	}

	/** Remove the cached copy (OPFS and IndexedDB). */
	async delete(name: string): Promise<void> {
		const { opfs, indexedDb, db } = this.deps;
		if (opfs) {
			try {
				await (await opfs()).removeEntry(name);
			} catch {
				// not present
			}
		}
		if (indexedDb) {
			try {
				await withStore(indexedDb, db, "readwrite", (s) => s.delete(name));
			} catch {
				// not present / no db
			}
		}
	}
}
