// test/core/strength/tablebase-policy.test.ts — max strength always plays the tables' move; human
// ratings only occasionally, never below the floor, and less in 6–7-man positions.
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { TABLEBASE_HUMAN as H, TABLEBASE } from "@core/constants/tablebase";
import { createRng } from "@core/rng";
import { decideTablebase, tablebaseProbability } from "@core/strength/tablebase-policy";

describe("tablebaseProbability", () => {
	it("is certain at max strength, whatever the effective rating", () => {
		for (const pieces of [3, 5, 7])
			expect(tablebaseProbability(LIMITS.eloMax, LIMITS.eloMax - 400, pieces)).toBe(1);
	});

	it("is zero out of range", () => {
		expect(tablebaseProbability(LIMITS.eloMax, LIMITS.eloMax, TABLEBASE.maxPieces + 1)).toBe(0);
		expect(tablebaseProbability(2500, 2500, TABLEBASE.maxPieces + 1)).toBe(0);
	});

	it("never replaces the human policy below the floor", () => {
		for (const E of [400, 800, 1200, H.floorElo - 1])
			for (const pieces of [3, 4, 5, 6, 7]) expect(tablebaseProbability(E, E, pieces)).toBe(0);
	});

	it("rises with rating and stays below certainty through the Maia range", () => {
		let previous = -1;
		for (let E = H.floorElo; E <= MAIA.eloMax; E += 100) {
			const p = tablebaseProbability(E, E, 4);
			expect(p).toBeGreaterThanOrEqual(previous);
			expect(p).toBeLessThanOrEqual(H.maxProb);
			previous = p;
		}
		expect(tablebaseProbability(H.floorElo, H.floorElo, 4)).toBeCloseTo(H.floorProb, 9);
		expect(tablebaseProbability(H.fullElo, H.fullElo, 4)).toBeCloseTo(H.maxProb, 9);
		expect(H.maxProb).toBeLessThan(1);
	});

	it("reaches certainty only at the top of the scale", () => {
		const below = tablebaseProbability(LIMITS.eloMax - 1, LIMITS.eloMax - 1, 4);
		expect(below).toBeGreaterThan(H.maxProb);
		expect(below).toBeLessThan(1);
	});

	it("scales 6–7-man positions down", () => {
		const E = 2400;
		const simple = tablebaseProbability(E, E, H.simpleMaxPieces);
		expect(tablebaseProbability(E, E, H.simpleMaxPieces + 1)).toBeCloseTo(simple * H.largeScale, 9);
	});

	it("reads the effective rating, not the target, below max strength", () => {
		expect(tablebaseProbability(2000, H.floorElo - 1, 4)).toBe(0);
	});
});

describe("decideTablebase", () => {
	it("draws nothing from the rng when the answer is certain either way", () => {
		const rng = createRng("tb");
		const before = createRng("tb").next();
		expect(decideTablebase(LIMITS.eloMax, LIMITS.eloMax, 4, rng).use).toBe(true);
		expect(decideTablebase(1000, 1000, 4, rng).use).toBe(false);
		expect(rng.next()).toBe(before);
	});

	it("uses the tables at roughly the stated rate", () => {
		const rng = createRng("tb-rate");
		const E = 2200;
		const p = tablebaseProbability(E, E, 4);
		let used = 0;
		const n = 4000;
		for (let i = 0; i < n; i += 1) if (decideTablebase(E, E, 4, rng).use) used += 1;
		expect(Math.abs(used / n - p)).toBeLessThan(0.03);
	});
});
