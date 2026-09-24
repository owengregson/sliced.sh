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

/** Exported training bands; selection and rating clamping live in chessmimic-scalers.ts. */
export const CHESSMIMIC_BANDS = [
	"0_1000",
	"1200_1300",
	"1500_1600",
	"1800_1900",
	"2000_2100",
	"2200_3500",
] as const;
export type ChessMimicBand = (typeof CHESSMIMIC_BANDS)[number];

/** Warm the default rating before settings arrive; game startup then warms its selected band. */
export const CHESSMIMIC_DEFAULT_BAND: ChessMimicBand = "1500_1600";

export interface ChessMimicBandFile {
	bytes: number;
	sha256: string;
	/** Lossless compression in the built extension only. */
	packed?: boolean;
	/** Shipped in the package (`MODELS_DIR`); otherwise downloaded on demand and cached in OPFS. */
	bundled: boolean;
}

/** `<band>.onnx` size and SHA-256 as exported (`models.json`; checked by `test/scripts`). */
export const CHESSMIMIC_BAND_FILES: Readonly<Record<ChessMimicBand, ChessMimicBandFile>> = {
	"0_1000": {
		packed: true,
		bytes: 18_200_481,
		sha256: "758533f588397e99be0a2ddfdb05bdb4729482269efdb90d9527a7f4ebb82470",
		bundled: true,
	},
	"1200_1300": {
		bytes: 18_200_481,
		sha256: "623b2489d2909734d1b5f6d6b5c45c97043fedd5d659429f4868ec706d614991",
		bundled: true,
		packed: true,
	},
	"1500_1600": {
		bytes: 19_247_529,
		sha256: "09ffcd130d46b3273f2186c38ffcf49aedc5dc17c1499f1bf04714599dd99bc8",
		bundled: true,
		packed: true,
	},
	"1800_1900": {
		bytes: 18_200_481,
		sha256: "121bc7a7fa7920f9b0cf55dfe642f1e32e33a82dea23831bfbc018fa8d8f6f22",
		bundled: true,
		packed: true,
	},
	"2000_2100": {
		bytes: 18_200_481,
		sha256: "f50058cdab70d1f21d987faf0c11ed3059d30ad57c6e095cf3472bceb51f3eb9",
		bundled: true,
		packed: true,
	},
	"2200_3500": {
		bytes: 18_200_481,
		sha256: "f799744bbdabbb4f30fcb44a3b1d17d7e04b1de6a449d6fb389297967e556110",
		bundled: true,
		packed: true,
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
