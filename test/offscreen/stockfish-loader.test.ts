import { describe, expect, it } from "bun:test";
import { ENGINE_FILES, ENGINE_PROGRAM_FILES } from "@core/constants/engine-files";
import { LIMITS } from "@core/constants/limits";
import {
	bootEngineDetailed,
	chooseModule,
	RELAXED_SIMD_ERROR,
	supportsRelaxedSimd,
} from "@offscreen/stockfish-loader";
import { FakeStockfishWeb } from "../fakes/stockfish";

describe("full NNUE boot", () => {
	it("loads both required full-build networks before returning a usable engine", async () => {
		const sf = new FakeStockfishWeb(LIMITS.nnueBigNames);
		const fetched: string[] = [];
		const result = await bootEngineDetailed("full", {
			crossOriginIsolated: true,
			getUrl: (path) => path,
			importModule: async () => ({ default: async () => sf }),
			memoryFactory: () => new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
			wasmValidate: () => true,
			nnueStore: {
				get: async (name) => {
					fetched.push(name);
					return new Uint8Array([fetched.length]);
				},
			},
		});
		expect(result.module).toBe("sf_18_relaxed-simd.js");
		expect(fetched).toEqual([...LIMITS.nnueBigNames]);
		expect(sf.nets.map((net) => net.index)).toEqual([0, 1]);
		expect(result.nnue).toEqual([...LIMITS.nnueBigNames]);
	});

	it("loads the relaxed-SIMD full build — the only one shipped — like the small net", async () => {
		const sf = new FakeStockfishWeb(LIMITS.nnueBigNames);
		const loaded: string[] = [];
		const result = await bootEngineDetailed("full", {
			crossOriginIsolated: true,
			getUrl: (path) => path,
			importModule: async (url) => {
				loaded.push(url);
				return { default: async () => sf };
			},
			memoryFactory: () => new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
			wasmValidate: () => true,
			nnueStore: { get: async () => new Uint8Array([1]) },
		});
		expect(result.module).toBe("sf_18_relaxed-simd.js");
		expect(loaded).toEqual(["assets/engine/sf_18_relaxed-simd.js"]);
		expect(chooseModule("smallnet")).toBe("sf_18_smallnet_relaxed-simd.js");
	});

	it("refuses to boot where relaxed SIMD is rejected, before importing anything", async () => {
		const loaded: string[] = [];
		await expect(
			bootEngineDetailed("smallnet", {
				crossOriginIsolated: true,
				getUrl: (path) => path,
				importModule: async (url) => {
					loaded.push(url);
					return { default: async () => new FakeStockfishWeb([LIMITS.nnueSmallName]) };
				},
				memoryFactory: () => new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
				wasmValidate: () => false,
				nnueStore: { get: async () => new Uint8Array([1]) },
			})
		).rejects.toThrow(RELAXED_SIMD_ERROR);
		expect(loaded).toEqual([]);
		expect(supportsRelaxedSimd(() => false)).toBe(false);
		expect(
			supportsRelaxedSimd(() => {
				throw new Error("no wasm");
			})
		).toBe(false);
	});

	it("ships no plain-SIMD program: every registered engine file is a relaxed-SIMD build", () => {
		for (const name of ENGINE_PROGRAM_FILES) expect(name).toMatch(/_relaxed-simd\.(?:js|wasm)$/);
		for (const variant of [ENGINE_FILES.smallnet, ENGINE_FILES.full])
			expect<string>(variant.wasm).toBe(variant.js.replace(/\.js$/, ".wasm"));
	});

	it("quits a newly allocated engine if either network download fails", async () => {
		const sf = new FakeStockfishWeb(LIMITS.nnueBigNames);
		await expect(
			bootEngineDetailed("full", {
				crossOriginIsolated: true,
				getUrl: (path) => path,
				importModule: async () => ({ default: async () => sf }),
				memoryFactory: () => new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
				wasmValidate: () => true,
				nnueStore: {
					get: async () => {
						throw new Error("network unavailable");
					},
				},
			})
		).rejects.toThrow("network unavailable");
		expect(sf.commands).toContain("quit");
	});
});
