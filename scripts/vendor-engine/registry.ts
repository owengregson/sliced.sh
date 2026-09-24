// scripts/vendor-engine/registry.ts — the slice of the constants registry the vendor step reads.
//
// Loaded lazily (`loadRegistry`) so the bundler-define placeholders are installed first:
// `limits.ts`/`urls.ts` read the bundler's `__SL_*` defines at module scope (the bundle and
// `test/setup.ts` provide them), so a plain `bun` run installs placeholders before importing.

import { installRegistryDefines } from "../lib/defines";
import type { NnueSource } from "../nnue-assets/codec";

export interface BookRegistry {
	dir: string;
	gm2600: string;
	club: string;
	theory: string;
}

export interface ModelsRegistry {
	MODELS_DIR: string;
	CHESSMIMIC_FILES: {
		scalers: string;
		buckets: string;
		vocab: string;
		manifest: string;
		onnxSuffix: string;
	};
	CHESSMIMIC_BANDS: readonly string[];
	CHESSMIMIC_BAND_FILES: Readonly<
		Record<string, { bytes: number; sha256: string; bundled: boolean }>
	>;
	CHESSMIMIC_UPSTREAM: {
		name: string;
		repo: string;
		commit: string;
		license: string;
		licenseName: string;
		licenseUrl: string;
		copyright: string;
		site: string;
	};
	ORT_DIR: string;
	ORT_PACKAGE: string;
	ORT_VERSION: string;
	ORT_FILES: { module: string; loader: string; wasm: string; license: string };
	chessmimicBandBase: string;
	onnxruntimeRepo: string;
	onnxruntimeRaw: string;
}

/** `src/core/constants/maia.ts`, the parts the notice needs. */
export interface MaiaRegistry {
	MAIA_DIR: string;
	MAIA_SIZES: readonly string[];
	MAIA_MODEL_FILES: Readonly<
		Record<
			string,
			{
				file: string;
				bytes: number;
				sha256: string;
				parts: number;
				upstream: {
					repo: string;
					revision: string;
					checkpoint: string;
					bytes: number;
					sha256: string;
				};
				params: number;
				dModel: number;
				heads: number;
			}
		>
	>;
	MAIA_FILES: { manifest: string; license: string; partSuffix: string; partBytes: number };
	MAIA_UPSTREAM: {
		name: string;
		repo: string;
		license: string;
		licenseName: string;
		licenseUrl: string;
		copyright: string;
		paper: string;
		paperTitle: string;
		hub: string;
	};
}

export interface EngineRegistry extends ModelsRegistry {
	maia: MaiaRegistry;
	BOOKS: BookRegistry;
	ENGINE_DIR: string;
	ENGINE_NNUE_SOURCES: readonly NnueSource[];
	ENGINE_FILES: {
		smallnet: { js: string; wasm: string; nnue: string };
		/** One net since Stockfish 19 retired the full build's secondary network; a list either way. */
		full: { js: string; wasm: string; nnue: readonly string[] };
	};
	nnueMirror: string;
	website: string;
}

export async function loadRegistry(): Promise<EngineRegistry> {
	installRegistryDefines();
	const [{ ENGINE_DIR, ENGINE_FILES, ENGINE_NNUE_SOURCES }, { URLS }, { BOOKS }, models, maia] =
		await Promise.all([
			import("../../src/core/constants/engine-files"),
			import("../../src/core/constants/urls"),
			import("../../src/core/constants/books"),
			import("../../src/core/constants/models"),
			import("../../src/core/constants/maia"),
		]);
	return {
		maia: {
			MAIA_DIR: maia.MAIA_DIR,
			MAIA_SIZES: maia.MAIA_SIZES,
			MAIA_MODEL_FILES: maia.MAIA_MODEL_FILES,
			MAIA_FILES: maia.MAIA_FILES,
			MAIA_UPSTREAM: maia.MAIA_UPSTREAM,
		},
		BOOKS,
		ENGINE_DIR,
		ENGINE_FILES,
		ENGINE_NNUE_SOURCES,
		nnueMirror: URLS.nnueMirror,
		website: URLS.website,
		MODELS_DIR: models.MODELS_DIR,
		CHESSMIMIC_FILES: models.CHESSMIMIC_FILES,
		CHESSMIMIC_BANDS: models.CHESSMIMIC_BANDS,
		CHESSMIMIC_BAND_FILES: models.CHESSMIMIC_BAND_FILES,
		CHESSMIMIC_UPSTREAM: models.CHESSMIMIC_UPSTREAM,
		ORT_DIR: models.ORT_DIR,
		ORT_PACKAGE: models.ORT_PACKAGE,
		ORT_VERSION: models.ORT_VERSION,
		ORT_FILES: models.ORT_FILES,
		chessmimicBandBase: URLS.chessmimicBandBase,
		onnxruntimeRepo: URLS.onnxruntimeRepo,
		onnxruntimeRaw: URLS.onnxruntimeRaw,
	};
}
