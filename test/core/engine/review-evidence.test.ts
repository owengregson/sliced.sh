import { describe, expect, it } from "bun:test";
import { ENGINE_FILES } from "@core/constants/engine-files";
import { assertFrameProvenance, type EvidenceFrame } from "../../../tools/move-review/evidence";

const frame: EvidenceFrame = {
	game: 0,
	index: 0,
	fen: "test",
	depth: 18,
	complete: true,
	elapsedMs: 100,
	lines: [],
	provenance: {
		version: "Stockfish 19",
		module: ENGINE_FILES.full.js,
		variant: "full",
		limitedStrength: false,
		networks: Object.fromEntries(ENGINE_FILES.full.nnue.map((name) => [name, name.slice(3, 15)])),
		wasmSha256: "program",
		datasetSha256: "dataset",
		runtime: "node",
		threads: 2,
		hashMb: 64,
	},
};

describe("review benchmark evidence provenance", () => {
	it("rejects stale SF18 evidence, another dataset, and different WASM even when the filename agrees", () => {
		expect(() => assertFrameProvenance(frame, "dataset", "program")).not.toThrow();
		for (const patch of [
			{ module: "sf_18.js" },
			{ datasetSha256: "other" },
			{ wasmSha256: "old-program" },
			{ networks: {} },
		]) {
			expect(() =>
				assertFrameProvenance(
					{ ...frame, provenance: { ...frame.provenance!, ...patch } },
					"dataset",
					"program"
				)
			).toThrow();
		}
	});
	it("requires an explicit opt-in for legacy files instead of silently calling them SF19", () => {
		const { provenance: _, ...legacy } = frame;
		expect(() => assertFrameProvenance(legacy, "dataset", "program")).toThrow();
		expect(() => assertFrameProvenance(legacy, "dataset", "program", true)).not.toThrow();
	});
});
