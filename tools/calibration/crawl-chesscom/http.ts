/**
 * tools/calibration/crawl-chesscom/http.ts — the crawl's only network access: serial GETs against
 * the chess.com public API with a gzipped on-disk cache keyed by sha1 of the URL (a rerun never
 * refetches), transient-error back-off and a request budget.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../common";

const USER_AGENT = "sliced-calibration-research/1.0";

export interface CacheEntry {
	url: string;
	status: number;
	body: unknown;
}

function cachePath(url: string): string {
	return path.join(PATHS.cache, `${createHash("sha1").update(url).digest("hex")}.json.gz`);
}

export function readCache(file: string): CacheEntry | null {
	if (!existsSync(file)) return null;
	try {
		const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(file)));
		return JSON.parse(text) as CacheEntry;
	} catch {
		return null;
	}
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
				writeFileSync(file, Bun.gzipSync(new TextEncoder().encode(JSON.stringify(entry))));
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
