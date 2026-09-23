/**
 * Boots the vendored `@lichess-org/stockfish-web` build inside the offscreen
 * document (§6.3, Appendix A §5/§7):
 *
 *   1. assert `crossOriginIsolated` (COOP/COEP manifest keys) — pthreads need a
 *      shared `WebAssembly.Memory`;
 *   2. assert `WebAssembly.validate` accepts a relaxed-simd probe — only the
 *      relaxed-simd builds ship (`ENGINE_FILES`; Chrome ≥ 114, the manifest
 *      requires 128), so there is nothing to fall back to;
 *   3. `import()` the ES-module factory from its extension URL and instantiate
 *      it with a shared memory, shrinking the initial size on failure
 *      (`LIMITS.engineMemoryInitialPages`: 2560 → 1536 → 1024 pages), always at
 *      the builds' own maximum (`LIMITS.engineMemoryMaxPages`, 2 GiB);
 *   4. fetch every recommended net (`getRecommendedNnue(i)`) from the
 *      `NnueStore`, then hand them over back to back via `setNnueBuffer(buf, i)`.
 *
 * Every platform touchpoint is injectable so the loader is unit-testable and
 * runnable under Bun (the integration test boots the real wasm this way).
 */

import { runtimeGetURL } from "@core/chrome/runtime";
import { ENGINE_DIR, ENGINE_FILES } from "@core/constants/engine-files";
import { LIMITS } from "@core/constants/limits";
import { log } from "@core/logger";
import type StockfishWeb from "@lichess-org/stockfish-web";
import type { EngineVariant } from "@typedefs/engine";
import { errorMessage } from "./shared/errors";

/** Status error when the document is not cross-origin isolated (no `SharedArrayBuffer`). */
export const CROSS_ORIGIN_ISOLATION_ERROR = "cross-origin isolation missing";

/** Status error when the runtime rejects relaxed SIMD: the only engine builds shipped need it. */
export const RELAXED_SIMD_ERROR = "relaxed SIMD unsupported (Chrome 114 or newer is required)";

/**
 * Smallest module exercising a relaxed-simd instruction: one function
 * `() -> v128` computing `i8x16.relaxed_swizzle(v128.const 0, v128.const 0)`.
 * `WebAssembly.validate` accepts it only where the relaxed-simd proposal is
 * implemented (Chrome ≥ 114).
 */
export const RELAXED_SIMD_PROBE: Uint8Array = Uint8Array.of(
	0x00,
	0x61,
	0x73,
	0x6d, // magic
	0x01,
	0x00,
	0x00,
	0x00, // version
	0x01,
	0x05,
	0x01,
	0x60,
	0x00,
	0x01,
	0x7b, // type: () -> v128
	0x03,
	0x02,
	0x01,
	0x00, // function 0 has type 0
	0x0a,
	0x2b,
	0x01,
	0x29,
	0x00, // code section, one body, no locals
	0xfd,
	0x0c,
	...new Array<number>(16).fill(0), // v128.const 0
	0xfd,
	0x0c,
	...new Array<number>(16).fill(0), // v128.const 0
	0xfd,
	0x80,
	0x02, // i8x16.relaxed_swizzle (0xfd 0x100)
	0x0b // end
);

/** Emscripten `moduleArg` the stockfish-web factory understands. */
export interface StockfishFactoryArgs {
	wasmMemory: WebAssembly.Memory;
	locateFile: (file: string, prefix: string) => string;
	mainScriptUrlOrBlob: string;
	listen?: (line: string) => void;
	onError?: (msg: string) => void;
}

export type StockfishFactory = (args: StockfishFactoryArgs) => Promise<StockfishWeb>;

export interface NnueSource {
	get(name: string): Promise<Uint8Array>;
}

export interface BootDeps {
	nnueStore: NnueSource;
	listen?: (line: string) => void;
	onError?: (msg: string) => void;
	/** Called with the recommended net names before they are fetched and set. */
	onLoadingNnue?: (names: string[]) => void;
	importModule?: (url: string) => Promise<{ default: StockfishFactory }>;
	wasmValidate?: (bytes: Uint8Array) => boolean;
	memoryFactory?: (initialPages: number, maximumPages: number) => WebAssembly.Memory;
	crossOriginIsolated?: boolean;
	getUrl?: (path: string) => string;
}

export interface BootedEngine {
	sf: StockfishWeb;
	/** The `.js` module that was loaded (e.g. `sf_19_smallnet_relaxed-simd.js`). */
	module: string;
	/** Recommended nets, in `setNnueBuffer` index order. */
	nnue: string[];
}

const defaultImport = (url: string): Promise<{ default: StockfishFactory }> =>
	import(url) as Promise<{ default: StockfishFactory }>;

const defaultValidate = (bytes: Uint8Array): boolean =>
	WebAssembly.validate(bytes as Uint8Array<ArrayBuffer>);

const defaultMemory = (initial: number, maximum: number): WebAssembly.Memory =>
	new WebAssembly.Memory({ initial, maximum, shared: true });

export function supportsRelaxedSimd(validate: (bytes: Uint8Array) => boolean): boolean {
	try {
		return validate(RELAXED_SIMD_PROBE);
	} catch {
		return false;
	}
}

/** The `.js` file for `variant` (always the relaxed-simd build — the only one shipped). */
export function chooseModule(variant: EngineVariant): string {
	return (variant === "full" ? ENGINE_FILES.full : ENGINE_FILES.smallnet).js;
}

/** `getRecommendedNnue(0..)` until it returns nothing. */
export function recommendedNnue(sf: StockfishWeb): string[] {
	const names: string[] = [];
	for (let i = 0; ; i++) {
		const name = sf.getRecommendedNnue(i);
		if (!name) break;
		names.push(name);
	}
	return names;
}

export async function bootEngineDetailed(
	variant: EngineVariant,
	deps: BootDeps
): Promise<BootedEngine> {
	const isolated = deps.crossOriginIsolated ?? globalThis.crossOriginIsolated === true;
	if (!isolated) throw new Error(CROSS_ORIGIN_ISOLATION_ERROR);
	const getUrl = deps.getUrl ?? runtimeGetURL;
	const validate = deps.wasmValidate ?? defaultValidate;
	const importModule = deps.importModule ?? defaultImport;
	const memoryFactory = deps.memoryFactory ?? defaultMemory;

	if (!supportsRelaxedSimd(validate)) throw new Error(RELAXED_SIMD_ERROR);
	const module = chooseModule(variant);
	const url = getUrl(ENGINE_DIR + module);
	const factory = (await importModule(url)).default;
	if (typeof factory !== "function") throw new Error(`engine module has no factory: ${module}`);

	let sf: StockfishWeb | undefined;
	let lastError: unknown;
	for (const initial of LIMITS.engineMemoryInitialPages) {
		try {
			const args: StockfishFactoryArgs = {
				wasmMemory: memoryFactory(initial, LIMITS.engineMemoryMaxPages),
				locateFile: (file) => getUrl(ENGINE_DIR + file),
				mainScriptUrlOrBlob: url,
			};
			if (deps.listen) args.listen = deps.listen;
			if (deps.onError) args.onError = deps.onError;
			sf = await factory(args);
			break;
		} catch (error) {
			lastError = error;
			log.warn("stockfish-loader: instantiation failed; shrinking memory", {
				module,
				initialPages: initial,
				error: errorMessage(error),
			});
		}
	}
	if (!sf) throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));

	const nnue = recommendedNnue(sf);
	deps.onLoadingNnue?.(nnue);
	try {
		// Fetched first, set back to back: the engine copies its whole network object on every set,
		// and a set left waiting on the next fetch keeps the heap at its peak for the whole wait.
		const buffers = await Promise.all(nnue.map((name) => deps.nnueStore.get(name)));
		for (let i = 0; i < buffers.length; i++) sf.setNnueBuffer(buffers[i] as Uint8Array, i);
	} catch (error) {
		// A failed download must not leak the newly allocated WASM instance and its workers.
		try {
			sf.uci("quit");
		} catch {
			/* The original download failure is more useful. */
		}
		throw error;
	}
	log.info("stockfish-loader: engine booted", { module, nnue });
	return { sf, module, nnue };
}

/** §6.3 `bootEngine(variant) → StockfishWeb` (see `bootEngineDetailed` for the module/net names). */
export async function bootEngine(variant: EngineVariant, deps: BootDeps): Promise<StockfishWeb> {
	return (await bootEngineDetailed(variant, deps)).sf;
}
