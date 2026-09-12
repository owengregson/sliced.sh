import { LIMITS } from "./limits";

/** Extension-relative directory holding the vendored engine (§6.2). */
export const ENGINE_DIR = "assets/engine/";

/**
 * Files vendored into `ENGINE_DIR` by `scripts/vendor-engine.ts` from
 * `@lichess-org/stockfish-web` (§6.1–6.2). Names are bare file names; the offscreen host
 * resolves them with `chrome.runtime.getURL(ENGINE_DIR + name)`. Each `.js` is the Emscripten
 * ES-module factory and doubles as the pthread worker script. Net names are the SHA-256 prefix
 * of the file and live in `LIMITS` only; `full.nnue` is the bundled `[big, small]` pair.
 *
 * Only the relaxed-SIMD builds ship (2026-09-13). Relaxed SIMD has been in Chrome since 114 and
 * the manifest requires 128, so the plain-SIMD `sf_18` / `sf_18_smallnet` programs the package
 * also publishes were dead weight (≈ 1.2 MB unpacked) — and the relaxed full build is what
 * lichess itself runs in Chrome (2026-09-12: the owner's pthread worker faults — "table index is
 * out of bounds" — were all on the plain build). The loader refuses to boot where the relaxed
 * probe fails rather than falling back to a build that is not there.
 */
export const ENGINE_FILES = {
	smallnet: {
		js: "sf_18_smallnet_relaxed-simd.js",
		wasm: "sf_18_smallnet_relaxed-simd.wasm",
		nnue: LIMITS.nnueSmallName,
	},
	full: {
		js: "sf_18_relaxed-simd.js",
		wasm: "sf_18_relaxed-simd.wasm",
		nnue: LIMITS.nnueBigNames,
	},
} as const;

/** The engine programs, in vendoring order (both variants' glue and wasm). */
export const ENGINE_PROGRAM_FILES = [
	ENGINE_FILES.smallnet.js,
	ENGINE_FILES.smallnet.wasm,
	ENGINE_FILES.full.js,
	ENGINE_FILES.full.wasm,
] as const;

/** The AGPL text the package ships next to its programs (`docs/DEVELOPMENT.md` §5.1). */
export const ENGINE_LICENSE_FILE = "LICENSE";

/** All variants load installed bytes first; the full network has no first-use download. */
export const BUNDLED_NNUE = [ENGINE_FILES.smallnet.nnue, ...ENGINE_FILES.full.nnue] as const;

/**
 * Everything `ENGINE_DIR` holds in the built package — and nothing else. The build copies only
 * these names out of `assets/engine/` (a stale program left on disk never ships) and
 * `verify-dist` rule 10 fails on an extra or a missing one.
 */
export const PACKAGED_ENGINE_FILES = [
	...ENGINE_PROGRAM_FILES,
	ENGINE_LICENSE_FILE,
	...BUNDLED_NNUE,
] as const;

/** The big source exceeds Git's hosting limit raw. Build expands it to its canonical name. */
export const ENGINE_NNUE_SOURCES = BUNDLED_NNUE.map((name) => ({
	name,
	source: name === ENGINE_FILES.full.nnue[0] ? `${name}.gz` : name,
}));
