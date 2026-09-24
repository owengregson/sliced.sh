/**
 * tools/timing-crawl/crawl/http.ts — strictly serial GETs against the chess.com public API with a
 * two-level on-disk cache. Every response body is cached gzipped under the crawl's own cache,
 * keyed by sha1(url) (the calibration crawl's format); the calibration crawl's cache is read as a
 * first-level cache and never written. A 404/410 is cached as a null body. 429, 5xx and network
 * errors back off exponentially (honouring Retry-After) and, after 8 attempts, throw
 * `TransientError` so the caller can requeue the player.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "./log";

export const API = "https://api.chess.com/pub";
const USER_AGENT = "sliced-calibration-research/1.0";

interface CacheEntry {
	url: string;
	status: number;
	body: unknown;
}

export class TransientError extends Error {}

function cacheName(url: string): string {
	return `${createHash("sha1").update(url).digest("hex")}.json.gz`;
}

function readCache(file: string): CacheEntry | null {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(file)))) as CacheEntry;
	} catch {
		return null;
	}
}

export class Http {
	net = 0;
	hitsOwn = 0;
	hitsCalib = 0;
	retries = 0;
	latencyMsTotal = 0;
	bytes = 0;
	constructor(
		private readonly own: string,
		private readonly calib: string,
		private readonly budget: number
	) {}

	get exhausted(): boolean {
		return this.net >= this.budget;
	}

	async get(url: string): Promise<unknown> {
		const name = cacheName(url);
		const ownFile = path.join(this.own, name);
		const mine = readCache(ownFile);
		if (mine) {
			this.hitsOwn++;
			return mine.body;
		}
		const theirs = readCache(path.join(this.calib, name));
		if (theirs && theirs.url === url) {
			this.hitsCalib++;
			return theirs.body;
		}
		for (let attempt = 0; ; attempt++) {
			this.net++;
			let status = 0;
			let body: unknown = null;
			let retryAfter = 0;
			const t0 = performance.now();
			try {
				const res = await fetch(url, {
					headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
					signal: AbortSignal.timeout(120_000),
				});
				status = res.status;
				retryAfter = Number(res.headers.get("retry-after") ?? 0) || 0;
				if (res.ok) {
					const text = await res.text();
					this.bytes += text.length;
					body = JSON.parse(text);
				} else await res.arrayBuffer();
			} catch (err) {
				status = 0;
				log(`  network error on ${url}: ${String(err)}`);
			}
			this.latencyMsTotal += performance.now() - t0;
			const transient = status === 0 || status === 429 || status >= 500;
			if (!transient) {
				const entry: CacheEntry = { url, status, body };
				const tmp = `${ownFile}.tmp`;
				writeFileSync(tmp, Bun.gzipSync(new TextEncoder().encode(JSON.stringify(entry))));
				renameSync(tmp, ownFile);
				return status >= 200 && status < 300 ? body : null;
			}
			this.retries++;
			if (attempt >= 7) throw new TransientError(`giving up on ${url} (status ${status})`);
			const wait = Math.min(300_000, Math.max(retryAfter * 1000, 2_000 * 2 ** attempt));
			log(`  ${status} on ${url}; retrying in ${Math.round(wait / 1000)}s`);
			await Bun.sleep(wait);
		}
	}
}
