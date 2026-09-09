/**
 * Timing-head model assets and the onnxruntime-web runtime (Task 34; §8.4b item 6, Appendix J
 * §B). ChessMimic's clock model (`thomasj02/1e4_ai`, PolyForm Noncommercial 1.0.0 — notice in
 * `docs/third-party.md`) is exported per rating band by `tools/data/08_export_chessmimic.py`;
 * the bands here are the ones registered with a SHA-256, so the offscreen store can verify a
 * cached or downloaded copy. `bundled` bands ship in the package under `MODELS_DIR`; a band
 * that is not bundled is fetched from `URLS.chessmimicBandBase` into OPFS on demand.
 */

export const MODELS_DIR = "assets/models/chessmimic/";

/** Side files written by the export next to the `.onnx` bands. */
export const CHESSMIMIC_FILES = {
	scalers: "scalers.json",
	buckets: "buckets.json",
	vocab: "vocab.json",
	manifest: "models.json",
	onnxSuffix: ".onnx",
} as const;

/** Registered bands, nearest-centre selection (`selectBand`); `<lo>_<hi>` names the Elo range. */
export const CHESSMIMIC_BANDS = ["1200_1300", "1500_1600", "1800_1900"] as const;
export type ChessMimicBand = (typeof CHESSMIMIC_BANDS)[number];

export interface ChessMimicBandFile {
	bytes: number;
	sha256: string;
	/** Shipped in the package (`MODELS_DIR`); otherwise downloaded on demand and cached in OPFS. */
	bundled: boolean;
}

/** `<band>.onnx` size and SHA-256 as exported (`models.json`; checked by `test/scripts`). */
export const CHESSMIMIC_BAND_FILES: Readonly<Record<ChessMimicBand, ChessMimicBandFile>> = {
	"1200_1300": {
		bytes: 18_200_481,
		sha256: "623b2489d2909734d1b5f6d6b5c45c97043fedd5d659429f4868ec706d614991",
		bundled: true,
	},
	"1500_1600": {
		bytes: 18_200_481,
		sha256: "5ea34ab9598ff67c9e94ff1658bc3aa9bfc9a62965514f0531a4cbc8adcd7e9b",
		bundled: true,
	},
	"1800_1900": {
		bytes: 18_200_481,
		sha256: "121bc7a7fa7920f9b0cf55dfe642f1e32e33a82dea23831bfbc018fa8d8f6f22",
		bundled: true,
	},
};

export function chessMimicBandFile(band: string): string {
	return `${band}${CHESSMIMIC_FILES.onnxSuffix}`;
}

export const CHESSMIMIC_UPSTREAM = {
	name: "ChessMimic",
	repo: "https://github.com/thomasj02/1e4_ai",
	commit: "8fcca2319e828b9d14b8def5c3ee9bc8bf1e3f12",
	license: "PolyForm-Noncommercial-1.0.0",
	licenseName: "PolyForm Noncommercial License 1.0.0",
	licenseUrl: "https://polyformproject.org/licenses/noncommercial/1.0.0",
	copyright: "Copyright 2026 Thomas Johnson (https://github.com/thomasj02/1e4_ai)",
	/** The live site the model powers; ChessMimic has no paper of its own (upstream README). */
	site: "https://1e4.ai",
} as const;

// ── onnxruntime-web ──────────────────────────────────────────────────────────────────────────

export const ORT_DIR = "assets/vendor/onnxruntime/";
export const ORT_PACKAGE = "onnxruntime-web";
/** Pinned exactly in `package.json` devDependencies; `scripts/vendor-engine.ts` copies the files. */
export const ORT_VERSION = "1.29.0";

/**
 * Files vendored from the package's `dist/`: the ESM entry (`import()`ed by URL from the
 * offscreen bundle — the `.min.js` build is an IIFE that cannot be imported), the Emscripten
 * loader the entry `import()`s through `env.wasm.wasmPaths`, and the SIMD + threads wasm. The
 * MIT licence text is fetched from the onnxruntime repository at the same tag.
 */
export const ORT_FILES = {
	module: "ort.wasm.min.mjs",
	loader: "ort-wasm-simd-threaded.mjs",
	wasm: "ort-wasm-simd-threaded.wasm",
	license: "LICENSE",
} as const;
