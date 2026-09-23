// src/offscreen/asset-store/idb.ts
/** Promise wrappers over one IndexedDB object store: the cache's fallback when OPFS is missing. */

import type { AssetDbLocation } from "./types";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

function openDb(factory: IDBFactory, db: AssetDbLocation): Promise<IDBDatabase> {
	const req = factory.open(db.name, db.version);
	req.onupgradeneeded = () => {
		if (!req.result.objectStoreNames.contains(db.store)) req.result.createObjectStore(db.store);
	};
	return request(req);
}

/** Open `db`, run one request in a `mode` transaction, wait for it to commit, close. */
export async function withStore<T>(
	factory: IDBFactory,
	db: AssetDbLocation,
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
