// test/integration/engine-under-bun.ts — running the real Stockfish wasm under Bun.
//
// Only the relaxed-SIMD builds ship (`ENGINE_FILES`, 2026-09-13), and Bun's JavaScriptCore
// rejects them: `WebAssembly.validate` is false for every `*_relaxed-simd.wasm` here, true for
// the package's plain-SIMD `sf_18*.wasm`. The Bun-hosted smoke tests therefore run the same
// Stockfish 18 from the plain-SIMD programs the npm package still publishes in `node_modules`
// (identical sources and nets, a different SIMD instruction set): the registry's module names
// map onto them, the wasm the plain glue asks its `locateFile` for comes from the same place,
// and the loader's relaxed-SIMD probe is bypassed. Nets resolve under `installedRoot` as usual.
// The full-engine fixture runs the shipped relaxed-SIMD variant in Node instead.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINE_FILES } from "@core/constants/engine-files";

export const ROOT = path.resolve(import.meta.dir, "../..");

export const STOCKFISH_PACKAGE_DIR = path.join(
	ROOT,
	"node_modules",
	"@lichess-org",
	"stockfish-web"
);

/** Registry module → the package's plain-SIMD glue of the same target. */
export const PLAIN_SIMD_PROGRAMS: Readonly<Record<string, string>> = {
	[ENGINE_FILES.smallnet.js]: "sf_18_smallnet.js",
	[ENGINE_FILES.full.js]: "sf_18.js",
};

/** `getUrl` for the loader: programs and their wasm from the package, everything else from `installedRoot`. */
export function bunEngineUrl(installedRoot: string, file: string): string {
	const name = path.basename(file);
	const plain = PLAIN_SIMD_PROGRAMS[name];
	if (plain !== undefined) return pathToFileURL(path.join(STOCKFISH_PACKAGE_DIR, plain)).href;
	if (name.endsWith(".wasm")) return pathToFileURL(path.join(STOCKFISH_PACKAGE_DIR, name)).href;
	return pathToFileURL(path.join(installedRoot, file)).href;
}

/** `wasmValidate` for the loader: the probe would fail under Bun, and the plain build needs no relaxed SIMD. */
export const BUN_WASM_VALIDATE = (): boolean => true;
