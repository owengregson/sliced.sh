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
	it("loads every required full-build network before returning a usable engine", async () => {
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
		expect(result.module).toBe("sf_19_relaxed-simd.js");
		expect(fetched).toEqual([...LIMITS.nnueBigNames]);
		// One index since Stockfish 19 retired the full build's secondary net; the loader sets
		// whatever `getRecommendedNnue` reports, so this follows the registry rather than a constant.
		expect(sf.nets.map((net) => net.index)).toEqual(LIMITS.nnueBigNames.map((_name, i) => i));
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
		expect(result.module).toBe("sf_19_relaxed-simd.js");
		expect(loaded).toEqual(["assets/engine/sf_19_relaxed-simd.js"]);
		expect(chooseModule("smallnet")).toBe("sf_19_smallnet_relaxed-simd.js");
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

	it("gives the full network room to load: the engine builds' own 2 GiB memory maximum", async () => {
		// 2026-09-15, measured on the Stockfish 18 full build (which then loaded two nets): at a
		// 512 MiB maximum the network copy could not grow the heap and a worker trapped ("table index
		// is out of bounds") — 17 of 20 Chrome boots with a gap between the nets; loading needed up to
		// 646 MiB. Stockfish 19 loads one net, so the peak is lower, but the cap is the maximum both
		// builds declare and stays the value to assert.
		const maxima: number[] = [];
		await bootEngineDetailed("full", {
			crossOriginIsolated: true,
			getUrl: (path) => path,
			importModule: async () => ({ default: async () => new FakeStockfishWeb(LIMITS.nnueBigNames) }),
			memoryFactory: (_initial, maximum) => {
				maxima.push(maximum);
				return new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
			},
			wasmValidate: () => true,
			nnueStore: { get: async () => new Uint8Array([1]) },
		});
		expect(maxima).toEqual([32768]);
	});

	it("fetches every network before handing any to the engine", async () => {
		// Setting one net and then waiting on the next one's fetch is what left the heap short
		// (2026-09-15, the two-net Stockfish 18 full build). Stockfish 19's full build has a single
		// network, which would satisfy this ordering trivially, so the fake advertises two: the loader
		// is count-agnostic — it sets whatever `getRecommendedNnue` reports — and this keeps the
		// guarantee under test for any build that ships more than one again.
		const twoNets = [...LIMITS.nnueBigNames, LIMITS.nnueSmallName];
		const sf = new FakeStockfishWeb(twoNets);
		const setWhenFetched: number[] = [];
		await bootEngineDetailed("full", {
			crossOriginIsolated: true,
			getUrl: (path) => path,
			importModule: async () => ({ default: async () => sf }),
			memoryFactory: () => new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
			wasmValidate: () => true,
			nnueStore: {
				get: async () => {
					setWhenFetched.push(sf.nets.length);
					await new Promise((resolve) => setTimeout(resolve, 1));
					return new Uint8Array([1]);
				},
			},
		});
		expect(setWhenFetched).toEqual([0, 0]);
		expect(sf.nets.map((net) => net.index)).toEqual([0, 1]);
	});

	it("quits a newly allocated engine if a network download fails", async () => {
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
