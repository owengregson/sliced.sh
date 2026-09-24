/** The bundled Polyglot books, fetched once each per policy. */

import { runtimeGetURL } from "@core/chrome/runtime";
import { BOOKS, type BookName } from "@core/constants/books";
import { log } from "@core/logger";
import { loadBook, type PolyglotBook } from "./polyglot";

export async function fetchBundledBook(name: string): Promise<Uint8Array | null> {
	try {
		const res = await fetch(runtimeGetURL(BOOKS.dir + name));
		if (!res.ok) return null;
		return new Uint8Array(await res.arrayBuffer());
	} catch (err) {
		log.warn("book: failed to load", name, err);
		return null;
	}
}

/** Loaded books by name (a failed load is cached as `null`, so it is not retried every move). */
export interface BookCache {
	get(name: BookName): Promise<PolyglotBook | null>;
	clear(): void;
}

export function createBookCache(load: (name: string) => Promise<Uint8Array | null>): BookCache {
	const books = new Map<BookName, Promise<PolyglotBook | null>>();
	return {
		get(name) {
			let pending = books.get(name);
			if (!pending) {
				pending = load(BOOKS[name])
					.then((bytes) => (bytes ? loadBook(bytes) : null))
					.catch((err: unknown) => {
						log.warn("book: load failed", name, err);
						return null;
					});
				books.set(name, pending);
			}
			return pending;
		},
		clear() {
			books.clear();
		},
	};
}
