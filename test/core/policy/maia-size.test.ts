// test/core/policy/maia-size.test.ts
/**
 * Which size answers for a target Elo, and where Maia stops being the selector.
 */

import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAIA, MAIA_SIZES } from "@core/constants/maia";
import { maiaConditioningElo, maiaSizeFor, usesMaia } from "@core/policy/maia-size";

describe("usesMaia", () => {
	it("selects through the inclusive Maia-led ceiling", () => {
		expect(MAIA.eloMax).toBe(3000);
		expect(usesMaia(2999)).toBe(true);
		expect(usesMaia(3000)).toBe(true);
		expect(usesMaia(3001)).toBe(false);
		expect(usesMaia(800)).toBe(true);
		expect(usesMaia(0)).toBe(true);
	});
	// Owner, 2026-09-15: one division at the Maia cutoff. This case used to pin the (3000, 3200]
	// `usesMaiaPrior` band (and its 12 → 4 cp `maiaPriorGapCp`); the band is removed, so it now pins
	// that nothing Maia remains above `MAIA.eloMax`.
	it("is the one strength division: no Maia of any kind above the cutoff", () => {
		for (const target of [MAIA.eloMax + 1, 3100, 3200, 3201, LIMITS.eloMax])
			expect(usesMaia(target)).toBe(false);
		expect(usesMaia(Number.NaN)).toBe(false);
	});
	it("caps conditioning independently of selection", () => {
		for (const elo of [400, 800, 2400, 2800, 3000]) expect(maiaConditioningElo(elo)).toBe(elo);
		for (const elo of [3001, 3200, 3800, 5000]) expect(maiaConditioningElo(elo)).toBe(3000);
		expect(maiaConditioningElo(Number.NaN)).toBe(MAIA.context.eloFloor);
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
		expect(MAIA.sizeBands).toEqual([{ maxElo: MAIA.eloMax, size: "79m" }]);
		for (const target of [-100, 0, 800, 1399, 1400, 1999, 2000, 2599, 2600, 3200, 5000])
			expect(maiaSizeFor(target)).toBe("79m");
	});
});
