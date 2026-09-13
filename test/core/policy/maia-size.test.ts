// test/core/policy/maia-size.test.ts
/**
 * Which size answers for a target Elo, and where Maia stops being the selector.
 */

import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAIA, MAIA_SIZES } from "@core/constants/maia";
import { maiaSizeFor, usesMaia, usesMaiaPrior } from "@core/policy/maia-size";

describe("usesMaia", () => {
	it("selects strictly below MAIA.eloMax with the human model on", () => {
		expect(MAIA.eloMax).toBe(2600);
		expect(usesMaia(2599)).toBe(true);
		expect(usesMaia(2600)).toBe(false);
		expect(usesMaia(2601)).toBe(false);
		expect(usesMaia(800)).toBe(true);
		expect(usesMaia(0)).toBe(true);
	});
	it("usesMaiaPrior (H15) covers exactly [MAIA.eloMax, LIMITS.eloMax), disjoint from usesMaia", () => {
		expect(usesMaiaPrior(MAIA.eloMax - 1)).toBe(false);
		expect(usesMaiaPrior(MAIA.eloMax)).toBe(true);
		expect(usesMaiaPrior(3000)).toBe(true);
		expect(usesMaiaPrior(LIMITS.eloMax - 1)).toBe(true);
		expect(usesMaiaPrior(LIMITS.eloMax)).toBe(false);
		for (const target of [800, 2599, 2600, 3200, LIMITS.eloMax])
			expect(usesMaia(target) && usesMaiaPrior(target)).toBe(false);
	});
});

describe("maiaSizeFor", () => {
	it("follows MAIA.sizeBands: nearest band at or below the ceiling", () => {
		const bands = MAIA.sizeBands;
		expect(bands.length).toBeGreaterThan(0);
		let floor = Number.NEGATIVE_INFINITY;
		for (const band of bands) {
			expect(MAIA_SIZES).toContain(band.size);
			expect(band.maxElo).toBeGreaterThan(floor);
			expect(maiaSizeFor(band.maxElo - 1)).toBe(band.size);
			if (Number.isFinite(floor)) expect(maiaSizeFor(floor)).toBe(band.size);
			floor = band.maxElo;
		}
		const last = bands[bands.length - 1];
		if (!last) throw new Error("no bands");
		expect(last.maxElo).toBe(MAIA.eloMax);
		expect(maiaSizeFor(last.maxElo)).toBe(last.size);
		expect(maiaSizeFor(last.maxElo + 1000)).toBe(last.size);
	});
	it("2026-09-13: one shipped size, the 79M model, for every rating (the Elo travels in the query)", () => {
		expect(MAIA_SIZES).toEqual(["79m"]);
		expect(MAIA.defaultSize).toBe("79m");
		expect(MAIA.prior.size).toBe("79m");
		expect(MAIA.sizeBands).toEqual([{ maxElo: MAIA.eloMax, size: "79m" }]);
		for (const target of [-100, 0, 800, 1399, 1400, 1999, 2000, 2599, 2600, 3200, 5000])
			expect(maiaSizeFor(target)).toBe("79m");
	});
});
