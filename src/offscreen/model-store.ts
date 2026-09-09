/**
 * ChessMimic band store for the offscreen document (Task 34): the `AssetStore` specialised for
 * `<band>.onnx` files. Only bands registered in `CHESSMIMIC_BAND_FILES` are served: bundled
 * ones come from `MODELS_DIR` in the package; the others from the OPFS cache or a download the
 * service worker relays (`model-request` → `model-chunk`s), verified against the registered
 * full SHA-256.
 */

import type { ModelChunk } from "@core/constants/messages";
import {
	CHESSMIMIC_BAND_FILES,
	CHESSMIMIC_FILES,
	type ChessMimicBandFile,
	MODELS_DIR,
} from "@core/constants/models";
import { MODEL_DB } from "@core/constants/storage-keys";
import { type AssetSpec, AssetStore, type AssetStoreDeps } from "./asset-store";

export const MODEL_CHECKSUM_ERROR = "model checksum mismatch";
export const MODEL_NAME_ERROR = "unknown model";

export interface ModelStoreDeps extends AssetStoreDeps {
	/** Band registry (tests inject one); default `CHESSMIMIC_BAND_FILES`. */
	files?: Readonly<Record<string, ChessMimicBandFile>>;
}

/** `<band>.onnx` → the registered band entry, if any. */
function entryFor(
	name: string,
	files: Readonly<Record<string, ChessMimicBandFile>>
): ChessMimicBandFile | undefined {
	const suffix = CHESSMIMIC_FILES.onnxSuffix;
	if (!name.endsWith(suffix)) return undefined;
	const band = name.slice(0, -suffix.length);
	return Object.hasOwn(files, band) ? files[band] : undefined;
}

function modelSpec(files: Readonly<Record<string, ChessMimicBandFile>>): AssetSpec {
	return {
		label: "model-store",
		nameError: MODEL_NAME_ERROR,
		checksumError: MODEL_CHECKSUM_ERROR,
		accepts: (name) => entryFor(name, files) !== undefined,
		bundledPath: (name) => (entryFor(name, files)?.bundled ? MODELS_DIR + name : undefined),
		expectedHash: (name) => entryFor(name, files)?.sha256,
		request: (name) => ({ kind: "model-request", name }),
		db: MODEL_DB,
	};
}

export class ModelStore extends AssetStore {
	constructor(deps: ModelStoreDeps) {
		super(modelSpec(deps.files ?? CHESSMIMIC_BAND_FILES), deps);
	}

	/** Route every `model-chunk` port message here. */
	override handleChunk(msg: ModelChunk): void {
		super.handleChunk(msg);
	}
}
