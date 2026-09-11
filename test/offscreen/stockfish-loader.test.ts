import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { bootEngineDetailed } from "@offscreen/stockfish-loader";
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
			nnueStore: {
				get: async (name) => {
					fetched.push(name);
					return new Uint8Array([fetched.length]);
				},
			},
		});
		expect(result.module).toBe("sf_18.js");
		expect(fetched).toEqual([...LIMITS.nnueBigNames]);
		expect(sf.nets.map((net) => net.index)).toEqual([0, 1]);
		expect(result.nnue).toEqual([...LIMITS.nnueBigNames]);
	});

	it("quits a newly allocated engine if either network download fails", async () => {
		const sf = new FakeStockfishWeb(LIMITS.nnueBigNames);
		await expect(
			bootEngineDetailed("full", {
				crossOriginIsolated: true,
				getUrl: (path) => path,
				importModule: async () => ({ default: async () => sf }),
				memoryFactory: () => new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
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
