/**
 * onnxruntime-web loader for the offscreen document (Task 34; §6.3). The vendored ESM entry
 * (`ORT_DIR + ORT_FILES.module`) is `import()`ed by its extension URL — the same way the
 * Stockfish factory is — and configured for the wasm backend: `env.wasm.wasmPaths` points at
 * the vendored Emscripten loader and the SIMD + threads wasm (no CDN), `numThreads` is the
 * capped hardware concurrency (threads need the document's COOP/COEP isolation, which the
 * engine already relies on; `timing-inference.ts` retries single-threaded if the pthread build
 * cannot start).
 *
 * `OrtRuntime` is the narrow, structural surface the inference host uses, so unit tests drive it
 * with a fake and the integration test with the real module under Bun.
 */

import { runtimeGetURL } from "@core/chrome/runtime";
import { LIMITS } from "@core/constants/limits";
import { ORT_DIR, ORT_FILES } from "@core/constants/models";
import { log } from "@core/logger";
import type * as Ort from "onnxruntime-web";

export type OrtTensorType = "int32" | "float32";

export interface OrtTensor {
	readonly type: string;
	readonly data: ArrayLike<number>;
	readonly dims: readonly number[];
}

export interface OrtSession {
	run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
	release(): Promise<void>;
}

export interface OrtRuntime {
	/** Threads the next session will be created with. */
	threads: number;
	setThreads(n: number): void;
	createSession(bytes: Uint8Array): Promise<OrtSession>;
	tensor(type: OrtTensorType, data: Int32Array | Float32Array, dims: number[]): OrtTensor;
}

export interface OrtLoaderDeps {
	importModule?: (url: string) => Promise<unknown>;
	getUrl?: (path: string) => string;
	/** Default: `min(LIMITS.timingInferenceThreadsMax, hardwareConcurrency)`, at least 1. */
	threads?: number;
	hardwareConcurrency?: number;
}

type OrtModule = typeof Ort;

const defaultImport = (url: string): Promise<unknown> => import(url);

export function defaultThreads(hardwareConcurrency: number | undefined): number {
	const cores = Number.isFinite(hardwareConcurrency) ? (hardwareConcurrency ?? 1) : 1;
	return Math.max(1, Math.min(LIMITS.timingInferenceThreadsMax, Math.floor(cores)));
}

function isOrtModule(mod: unknown): mod is OrtModule {
	if (!mod || typeof mod !== "object") return false;
	const m = mod as { InferenceSession?: { create?: unknown }; Tensor?: unknown; env?: unknown };
	return (
		typeof m.InferenceSession?.create === "function" &&
		typeof m.Tensor === "function" &&
		typeof m.env === "object"
	);
}

export async function createOrtRuntime(deps: OrtLoaderDeps = {}): Promise<OrtRuntime> {
	const getUrl = deps.getUrl ?? runtimeGetURL;
	const importModule = deps.importModule ?? defaultImport;
	const url = getUrl(ORT_DIR + ORT_FILES.module);
	const mod = await importModule(url);
	if (!isOrtModule(mod)) throw new Error(`onnxruntime module has no InferenceSession: ${url}`);
	mod.env.wasm.wasmPaths = {
		mjs: getUrl(ORT_DIR + ORT_FILES.loader),
		wasm: getUrl(ORT_DIR + ORT_FILES.wasm),
	};
	mod.env.wasm.proxy = false;
	const threads =
		deps.threads ??
		defaultThreads(deps.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency);
	const runtime: OrtRuntime = {
		threads,
		setThreads(n) {
			runtime.threads = Math.max(1, Math.floor(n));
		},
		async createSession(bytes) {
			mod.env.wasm.numThreads = runtime.threads;
			const session = await mod.InferenceSession.create(bytes, {
				executionProviders: ["wasm"],
				graphOptimizationLevel: "all",
			});
			return {
				run: async (feeds) =>
					(await session.run(feeds as unknown as Ort.InferenceSession.FeedsType)) as unknown as Record<
						string,
						OrtTensor
					>,
				release: () => session.release(),
			};
		},
		tensor(type, data, dims) {
			return type === "int32"
				? new mod.Tensor("int32", data as Int32Array, dims)
				: new mod.Tensor("float32", data as Float32Array, dims);
		},
	};
	log.info("ort-loader: onnxruntime-web loaded", { threads });
	return runtime;
}
