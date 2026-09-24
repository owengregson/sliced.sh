/**
 * tools/lib/chesscom-cache.ts — the on-disk format of the chess.com API response caches the crawls
 * share (`data/calibration/http-cache/`, and the think-time crawl's own, which reads the former as
 * a first level): one gzipped JSON `CacheEntry` per URL, named by sha1 of the URL. The fetch
 * policy (budget, back-off, atomic writes) stays with each crawl.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export interface CacheEntry {
	url: string;
	status: number;
	body: unknown;
}

/** `<sha1(url) hex>.json.gz`. */
export function cacheName(url: string): string {
	return `${createHash("sha1").update(url).digest("hex")}.json.gz`;
}

/** The entry stored in `file`, or null when it is absent or unreadable. */
export function readCache(file: string): CacheEntry | null {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(file)))) as CacheEntry;
	} catch {
		return null;
	}
}

/** An entry as the bytes of its cache file. */
export function encodeCache(entry: CacheEntry): Uint8Array {
	return Bun.gzipSync(new TextEncoder().encode(JSON.stringify(entry)));
}
