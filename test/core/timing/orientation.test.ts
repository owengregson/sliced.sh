// test/core/timing/orientation.test.ts — §8.4b item 2 orientation latency.
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { computeFeatures } from "@core/timing/features";
import { sampleOrientationMs } from "@core/timing/orientation";
import { ctx, median } from "./helpers";

const N = 20_000;

describe("orientation latency", () => {
	it("is ≥ 150 ms with median ≈ 380 ms", () => {
		const f = computeFeatures(ctx({ evalBeforeOppMove: null }));
		const rng = createRng("orient");
		const xs = Array.from({ length: N }, () => sampleOrientationMs(f, rng));
		for (const x of xs) expect(x).toBeGreaterThanOrEqual(150);
		expect(median(xs)).toBeGreaterThan(360);
		expect(median(xs)).toBeLessThan(400);
	});
	it("is longer after a surprising move and shorter for an expected reply", () => {
		const base = computeFeatures(ctx({ evalBeforeOppMove: null }));
		const surprised = computeFeatures(ctx({ evalBeforeOppMove: 220 })); // swing +200
		const expected = computeFeatures(
			ctx({ evalBeforeOppMove: null, moves: ["e2e4", "e7e5"], expectedOppReply: "e7e5" })
		);
		const draw = (f: typeof base) => {
			const rng = createRng("orient2");
			return median(Array.from({ length: N }, () => sampleOrientationMs(f, rng)));
		};
		expect(draw(surprised)).toBeGreaterThan(draw(base) * 1.5);
		expect(draw(expected)).toBeLessThan(draw(base) * 0.85);
	});
});
