/**
 * NNUE network store for the offscreen document (§6.3, Appendix A §5): the `AssetStore`
 * specialised for Stockfish nets. A net is `nn-<sha256[0:12]>.nnue`: the 12 hex digits in the
 * name are the hash prefix a cached or downloaded copy must match; the smallnet is bundled under
 * `ENGINE_DIR`; anything else is requested from the service worker with `nnue-request` and
 * arrives as `nnue-chunk`s.
 */

import { ENGINE_DIR } from "@core/constants/engine-files";
import { LIMITS } from "@core/constants/limits";
import type { NnueChunk } from "@core/constants/messages";
import { NNUE_DB } from "@core/constants/storage-keys";
import { type AssetSpec, AssetStore, type AssetStoreDeps } from "./asset-store";

export type {
	AssetFetchResponse as NnueFetchResponse,
	OpfsDirectory,
	OpfsFileHandle,
	OpfsWritable,
} from "./asset-store";
export { sha256Hex } from "./asset-store";

export const NNUE_CHECKSUM_ERROR = "nnue checksum mismatch";
export const NNUE_NAME_ERROR = "invalid nnue name";
/** `nn-<12 hex>.nnue` — the only shape that may reach the file system or the mirror. */
const NNUE_NAME_RE = /^nn-[0-9a-f]{12}\.nnue$/;

/** `nn-<12 hex>.nnue` → the 12 hex digits. */
const HASH_START = 3;
const HASH_END = 15;

export function nnueHashPrefix(name: string): string {
	return name.slice(HASH_START, HASH_END);
}

export interface NnueStoreDeps extends AssetStoreDeps {
	/** Net names shipped in the package. Default: `[LIMITS.nnueSmallName]`. */
	bundled?: readonly string[];
}

function nnueSpec(bundled: ReadonlySet<string>): AssetSpec {
	return {
		label: "nnue-store",
		nameError: NNUE_NAME_ERROR,
		checksumError: NNUE_CHECKSUM_ERROR,
		accepts: (name) => NNUE_NAME_RE.test(name),
		bundledPath: (name) => (bundled.has(name) ? ENGINE_DIR + name : undefined),
		expectedHash: nnueHashPrefix,
		request: (name) => ({ kind: "nnue-request", name }),
		db: NNUE_DB,
	};
}

export class NnueStore extends AssetStore {
	constructor(deps: NnueStoreDeps) {
		super(nnueSpec(new Set(deps.bundled ?? [LIMITS.nnueSmallName])), deps);
	}

	/** Route every `nnue-chunk` port message here. */
	override handleChunk(msg: NnueChunk): void {
		super.handleChunk(msg);
	}
}
