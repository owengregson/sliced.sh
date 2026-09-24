/** Bundled Maia models: stream-decode, verify canonical length and hash, then hand bytes to ORT. */

import { runtimeGetURL } from "@core/chrome/runtime";
import {
	MAIA_DIR,
	MAIA_MODEL_FILES,
	MAIA_SIZES,
	type MaiaModelFile,
	type MaiaSize,
} from "@core/constants/maia";
import { packagedModelName } from "@core/constants/model-packing";
import { log } from "@core/logger";
import { type AssetFetchResponse, sha256Hex } from "./asset-store";
import { unpackModelResponse } from "./model-unpack";
import { errorMessage } from "./shared/errors";
import { SingleFlight } from "./shared/single-flight";

export const MAIA_SIZE_ERROR = "unknown maia size";
export const MAIA_FETCH_ERROR = "maia model not readable";
export const MAIA_LENGTH_ERROR = "maia model length mismatch";
export const MAIA_CHECKSUM_ERROR = "maia model checksum mismatch";

/** The registry fields the store verifies against (tests inject fakes with the same shape). */
export type MaiaStoreEntry = Pick<MaiaModelFile, "file" | "bytes" | "sha256" | "packed">;

export interface MaiaStoreDeps {
	fetch?: (url: string) => Promise<AssetFetchResponse>;
	getUrl?: (path: string) => string;
	digest?: (data: Uint8Array) => Promise<ArrayBuffer>;
	/** Registry override (tests); default `MAIA_MODEL_FILES`. A size missing here is unknown. */
	files?: Readonly<Partial<Record<MaiaSize, MaiaStoreEntry>>>;
}

/** What `policy-inference.ts` needs from the store. */
export interface MaiaSource {
	get(size: MaiaSize): Promise<Uint8Array>;
}

export function isMaiaSize(value: unknown): value is MaiaSize {
	return typeof value === "string" && (MAIA_SIZES as readonly string[]).includes(value);
}

export class MaiaStore implements MaiaSource {
	private readonly flights = new SingleFlight<MaiaSize, Uint8Array>();
	private readonly fetchFn: (url: string) => Promise<AssetFetchResponse>;
	private readonly getUrl: (path: string) => string;
	private readonly digest: ((data: Uint8Array) => Promise<ArrayBuffer>) | undefined;
	private readonly files: Readonly<Partial<Record<MaiaSize, MaiaStoreEntry>>>;

	constructor(deps: MaiaStoreDeps = {}) {
		this.fetchFn = deps.fetch ?? ((url) => fetch(url));
		this.getUrl = deps.getUrl ?? runtimeGetURL;
		this.digest = deps.digest;
		this.files = deps.files ?? MAIA_MODEL_FILES;
	}

	/** Extension-relative path of a size's model, or `undefined` for a size not in the registry. */
	path(size: MaiaSize): string | undefined {
		const entry = this.files[size];
		return entry ? MAIA_DIR + packagedModelName(entry.file, entry.packed) : undefined;
	}

	/** Bytes of `size`'s model, verified; concurrent calls for one size share the work. */
	get(size: MaiaSize): Promise<Uint8Array> {
		return this.flights.run(size, (s) => this.load(s));
	}

	private async load(size: MaiaSize): Promise<Uint8Array> {
		const entry = isMaiaSize(size) ? this.files[size] : undefined;
		if (!entry) throw new Error(`${MAIA_SIZE_ERROR}: ${String(size)}`);
		const path = MAIA_DIR + packagedModelName(entry.file, entry.packed);
		let data: Uint8Array;
		try {
			const res = await this.fetchFn(this.getUrl(path));
			if (!res.ok) throw new Error("response not ok");
			data = entry.packed
				? await unpackModelResponse(res, entry.bytes)
				: new Uint8Array(await res.arrayBuffer());
		} catch (error) {
			log.warn("maia-store: bundled fetch failed", { size, path, error: errorMessage(error) });
			throw new Error(`${MAIA_FETCH_ERROR}: ${entry.file}`);
		}
		// Length first: it is free, and a truncated file is the likely failure of a joined asset.
		if (data.length !== entry.bytes) {
			log.warn("maia-store: length mismatch", { size, expected: entry.bytes, actual: data.length });
			throw new Error(`${MAIA_LENGTH_ERROR}: ${entry.file}`);
		}
		const hash = await sha256Hex(data, this.digest);
		if (hash !== entry.sha256) {
			log.warn("maia-store: checksum mismatch", { size, expected: entry.sha256, actual: hash });
			throw new Error(`${MAIA_CHECKSUM_ERROR}: ${entry.file}`);
		}
		return data;
	}
}
