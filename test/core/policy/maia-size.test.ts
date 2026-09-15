// test/core/policy/maia-size.test.ts
/**
 * Which size answers for a target Elo, and where Maia stops being the selector.
 */

import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAIA, MAIA_SIZES } from "@core/constants/maia";
import {
	maiaConditioningElo,
	maiaPriorGapCp,
	maiaSizeFor,
	usesMaia,
	usesMaiaPrior,
} from "@core/policy/maia-size";

describe("usesMaia", () => {
	it("selects through the inclusive Maia-led ceiling", () => {
		expect(MAIA.eloMax).toBe(3000);
		expect(usesMaia(2999)).toBe(true);
		expect(usesMaia(3000)).toBe(true);
		expect(usesMaia(3001)).toBe(false);
		expect(usesMaia(800)).toBe(true);
		expect(usesMaia(0)).toBe(true);
	});
	it("usesMaiaPrior covers only (3000, 3200], disjoint from direct Maia", () => {
		expect(usesMaiaPrior(MAIA.eloMax - 1)).toBe(false);
		expect(usesMaiaPrior(MAIA.eloMax)).toBe(false);
		expect(usesMaiaPrior(3001)).toBe(true);
		expect(usesMaiaPrior(3200)).toBe(true);
		expect(usesMaiaPrior(3201)).toBe(false);
		expect(usesMaiaPrior(LIMITS.eloMax)).toBe(false);
		for (const target of [800, 2599, 2600, 3200, LIMITS.eloMax])
			expect(usesMaia(target) && usesMaiaPrior(target)).toBe(false);
	});
	it("caps conditioning independently of selection and narrows the upper prior", () => {
		for (const elo of [400, 800, 2400, 2800, 3000]) expect(maiaConditioningElo(elo)).toBe(elo);
		for (const elo of [3001, 3200, 3800, 5000]) expect(maiaConditioningElo(elo)).toBe(3000);
		expect(maiaConditioningElo(Number.NaN)).toBe(MAIA.context.eloFloor);
		expect(maiaPriorGapCp(3000)).toBe(12);
		expect(maiaPriorGapCp(3100)).toBe(8);
		expect(maiaPriorGapCp(3200)).toBe(4);
	});
	it("rounds the actual self-conditioning value only after clamping it", () => {
		expect(maiaConditioningElo(-0.6)).toBe(0);
		expect(maiaConditioningElo(1423.535655)).toBe(1424);
		expect(maiaConditioningElo(1423.499)).toBe(1423);
		expect(maiaConditioningElo(3000.6)).toBe(3000);
		for (const elo of [400.1, 1200.5, 1423.535655, 2800.8, 2999.9]) {
			expect(Number.isInteger(maiaConditioningElo(elo))).toBe(true);
			expect(Math.abs(maiaConditioningElo(elo) - elo)).toBeLessThanOrEqual(0.5);
		}
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
