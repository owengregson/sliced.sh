import { LIMITS } from "./limits";

/** Extension-relative directory holding the vendored engine (§6.2). */
export const ENGINE_DIR = "assets/engine/";

/**
 * Files vendored into `ENGINE_DIR` by `scripts/vendor-engine.ts` from
 * `@lichess-org/stockfish-web` (§6.1–6.2). Names are bare file names; the offscreen host
 * resolves them with `chrome.runtime.getURL(ENGINE_DIR + name)`. Each `.js` is the Emscripten
 * ES-module factory and doubles as the pthread worker script. Net names are the SHA-256 prefix
 * of the file and live in `LIMITS` only; `full.nnue` is `[big, small]` and is not bundled.
 */
export const ENGINE_FILES = {
	smallnet: {
		js: "sf_18_smallnet.js",
		wasm: "sf_18_smallnet.wasm",
		relaxedJs: "sf_18_smallnet_relaxed-simd.js",
		relaxedWasm: "sf_18_smallnet_relaxed-simd.wasm",
		nnue: LIMITS.nnueSmallName,
	},
	full: {
		js: "sf_18.js",
		wasm: "sf_18.wasm",
		nnue: LIMITS.nnueBigNames,
	},
} as const;
