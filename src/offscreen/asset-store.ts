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
 * each chunk that makes progress: a service worker that never answers (no handler registered,
 * the relay wedged, the port silently dead) rejects the download instead of leaving a promise
 * pending forever. That matters beyond the wasted memory — `timing-inference.ts` awaits its band
 * candidates serially, so a download that never settles would wedge the head on that band and
 * never reach the substitute. The budget is a stall, not a total, so a slow 72 MB NNUE still
 * finishes; `download-relay.ts` posts chunks *while* the body streams, which is what makes the
 * distinction real. Only a new, non-empty index rearms, so a repeated or empty chunk cannot
 * extend a download indefinitely, and `TIMINGS.assetDownloadTotalMs` caps the whole transfer as
 * a backstop.
 *
 * Chunks carry base64 because runtime ports JSON-serialise their payloads (see `NnueChunk`).
 *
 * The parts: `asset-store/cache.ts` (OPFS + IndexedDB), `asset-store/relay.ts` (the relayed
 * download and its budgets), `asset-store/hash.ts` (verification). This class is the policy that
 * orders them.
 */

import { runtimeGetURL } from "@core/chrome/runtime";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { DEFAULT_SCHEDULER } from "@core/util/scheduler";
import { AssetCache, defaultOpfs } from "./asset-store/cache";
import { type Digest, defaultDigest, sha256Hex } from "./asset-store/hash";
import { DownloadRelay } from "./asset-store/relay";
import type {
	AssetChunk,
	AssetFetchResponse,
	AssetSpec,
	AssetStoreDeps,
} from "./asset-store/types";
import { errorMessage } from "./shared/errors";
import { SingleFlight } from "./shared/single-flight";

export { sha256Hex } from "./asset-store/hash";
export { ASSET_DOWNLOAD_STALLED, ASSET_DOWNLOAD_TOO_LONG } from "./asset-store/relay";
export type {
	AssetChunk,
	AssetFetchResponse,
	AssetSpec,
	AssetStoreDeps,
	OpfsDirectory,
	OpfsFileHandle,
	OpfsWritable,
} from "./asset-store/types";

/** Downloads tried before giving up on a checksum mismatch (initial + one re-request). */
const DOWNLOAD_ATTEMPTS = 2;

export class AssetStore {
	private readonly flights = new SingleFlight<string, Uint8Array>();
	private readonly fetchFn: (url: string) => Promise<AssetFetchResponse>;
	private readonly getUrl: (path: string) => string;
	private readonly digest: Digest;
	private readonly cache: AssetCache;
	private readonly relay: DownloadRelay;

	constructor(
		protected readonly spec: AssetSpec,
		deps: AssetStoreDeps
	) {
		this.fetchFn = deps.fetch ?? ((url) => fetch(url));
		this.getUrl = deps.getUrl ?? runtimeGetURL;
		this.digest = deps.digest ?? defaultDigest;
		this.cache = new AssetCache({
			label: spec.label,
			opfs: deps.opfs === undefined ? defaultOpfs() : deps.opfs,
			indexedDb: deps.indexedDb === undefined ? (globalThis.indexedDB ?? null) : deps.indexedDb,
			db: spec.db,
		});
		this.relay = new DownloadRelay({
			label: spec.label,
			post: deps.post,
			request: (name) => spec.request(name),
			onProgress: deps.onProgress,
			scheduler: deps.scheduler ?? DEFAULT_SCHEDULER,
			stallMs: deps.stallMs ?? TIMINGS.assetDownloadStallMs,
			totalMs: deps.totalMs ?? TIMINGS.assetDownloadTotalMs,
		});
	}

	/** Bytes of `name`, verified; concurrent calls for one name share the work. */
	get(name: string): Promise<Uint8Array> {
		return this.flights.run(name, (n) => this.load(n));
	}

	/** Route every relayed chunk of this family here. */
	handleChunk(msg: AssetChunk): void {
		this.relay.handleChunk(msg);
	}

	/** Remove a cached copy (OPFS and IndexedDB). */
	delete(name: string): Promise<void> {
		return this.cache.delete(name);
	}

	/** Fail every pending download (the port went away). */
	abortAll(reason: string): void {
		this.relay.abortAll(reason);
	}

	private async load(name: string): Promise<Uint8Array> {
		if (!this.spec.accepts(name)) throw new Error(`${this.spec.nameError}: ${name}`);
		const bundledPath = this.spec.bundledPath(name);
		if (bundledPath !== undefined) {
			const bundled = await this.readBundled(name, bundledPath);
			if (bundled) return bundled;
		}
		const cached = await this.cache.read(name);
		if (cached) {
			if (await this.verify(cached, name)) return cached;
			log.warn(`${this.spec.label}: cached copy failed its checksum; deleting`, { name });
			await this.delete(name);
		}
		for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
			const data = await this.relay.download(name);
			if (await this.verify(data, name)) {
				await this.cache.write(name, data);
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
			if (this.spec.decodeBundled) {
				const data = await this.spec.decodeBundled(name, res);
				if (!(await this.verify(data, name))) throw new Error(this.spec.checksumError);
				return data;
			}
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
}
