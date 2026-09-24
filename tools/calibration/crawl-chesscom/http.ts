/**
 * tools/calibration/crawl-chesscom/http.ts — the crawl's only network access: serial GETs against
 * the chess.com public API with a gzipped on-disk cache keyed by sha1 of the URL (a rerun never
 * refetches), transient-error back-off and a request budget.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { type CacheEntry, cacheName, encodeCache, readCache } from "../../lib/chesscom-cache";
import { PATHS } from "../common";

export { type CacheEntry, readCache };

const USER_AGENT = "sliced-calibration-research/1.0";

function cachePath(url: string): string {
	return path.join(PATHS.cache, cacheName(url));
}

export class Http {
	requests = 0;
	constructor(private readonly budget: number) {}

	get exhausted(): boolean {
		return this.requests >= this.budget;
	}

	/** The JSON body (null on 404/410/other client errors), or "budget" when out of requests. */
	async get(url: string): Promise<unknown | "budget"> {
		const file = cachePath(url);
		const hit = readCache(file);
		if (hit) return hit.body;
		if (this.exhausted) return "budget";
		for (let attempt = 0; ; attempt++) {
			this.requests++;
			let status = 0;
			let body: unknown = null;
			try {
				const res = await fetch(url, {
					headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
				});
				status = res.status;
				if (res.ok) body = await res.json();
				else await res.arrayBuffer();
			} catch (err) {
				status = 0;
				process.stderr.write(`  network error on ${url}: ${String(err)}\n`);
			}
			const transient = status === 0 || status === 429 || status >= 500;
			if (!transient) {
				const entry: CacheEntry = { url, status, body };
				writeFileSync(file, encodeCache(entry));
				return body;
			}
			if (attempt >= 6 || this.exhausted) {
				process.stderr.write(`  giving up on ${url} (status ${status})\n`);
				return null;
			}
			const wait = Math.min(120_000, 2_000 * 2 ** attempt);
			process.stderr.write(`  ${status} on ${url}; retrying in ${wait / 1000}s\n`);
			await Bun.sleep(wait);
		}
	}
}
