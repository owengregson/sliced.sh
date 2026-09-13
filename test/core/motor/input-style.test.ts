import { describe, expect, it } from "bun:test";
import { CLICK_MOVE } from "@core/motor/constants";
import { autoClickProbFor } from "@core/motor/input-style";
import { createRng } from "@core/rng";

describe("auto input mode: click share by travel distance", () => {
	it("a short hop keeps the base click share, a long carry the far one", () => {
		expect(autoClickProbFor("e2", "e4")).toBe(CLICK_MOVE.autoClickProb);
		expect(autoClickProbFor("g1", "f3")).toBe(CLICK_MOVE.autoClickProb);
		expect(autoClickProbFor("e1", "g1")).toBe(CLICK_MOVE.autoClickProb);
		expect(autoClickProbFor("a1", "a5")).toBe(CLICK_MOVE.autoClickProbFar);
		expect(autoClickProbFor("c1", "h6")).toBe(CLICK_MOVE.autoClickProbFar);
		expect(autoClickProbFor("d1", "h5")).toBe(CLICK_MOVE.autoClickProbFar);
		expect(CLICK_MOVE.autoClickProbFar).toBeLessThan(CLICK_MOVE.autoClickProb);
	});

	it("the threshold is exactly the registered distance", () => {
		expect(autoClickProbFor("a1", "d1")).toBe(CLICK_MOVE.autoClickProb);
		expect(autoClickProbFor("a1", "e1")).toBe(CLICK_MOVE.autoClickProbFar);
	});

	it("low on time the click wins whatever the distance, ramping in from 30 s to 10 s left", () => {
		// a full clock changes nothing
		expect(autoClickProbFor("a1", "a8", 120_000)).toBe(CLICK_MOVE.autoClickProbFar);
		expect(autoClickProbFor("e2", "e4", CLICK_MOVE.lowTimeRampMs)).toBe(CLICK_MOVE.autoClickProb);
		// at and below the floor the low-time share applies to hops and carries alike
		expect(autoClickProbFor("a1", "a8", CLICK_MOVE.lowTimeMs)).toBeCloseTo(
			CLICK_MOVE.lowTimeClickProb,
			9
		);
		expect(autoClickProbFor("e2", "e4", 3_000)).toBeCloseTo(CLICK_MOVE.lowTimeClickProb, 9);
		// halfway through the ramp, halfway between
		const mid = (CLICK_MOVE.lowTimeRampMs + CLICK_MOVE.lowTimeMs) / 2;
		expect(autoClickProbFor("a1", "a8", mid)).toBeCloseTo(
			(CLICK_MOVE.autoClickProbFar + CLICK_MOVE.lowTimeClickProb) / 2,
			9
		);
		expect(CLICK_MOVE.lowTimeClickProb).toBeGreaterThan(CLICK_MOVE.autoClickProb);
		// an unknown or zero clock (untimed) is not "low"
		expect(autoClickProbFor("e2", "e4", undefined)).toBe(CLICK_MOVE.autoClickProb);
		expect(autoClickProbFor("e2", "e4", 0)).toBe(CLICK_MOVE.autoClickProb);
	});

	it("drawn per move, long carries are dragged far more often than short hops", () => {
		let shortClicks = 0;
		let longClicks = 0;
		const n = 4000;
		for (let i = 0; i < n; i++) {
			const rng = createRng(`style:${i}`);
			if (rng.chance(autoClickProbFor("e2", "e4"))) shortClicks++;
			if (rng.chance(autoClickProbFor("a1", "a8"))) longClicks++;
		}
		expect(shortClicks / n).toBeGreaterThan(0.28);
		expect(shortClicks / n).toBeLessThan(0.4);
		expect(longClicks / n).toBeGreaterThan(0.07);
		expect(longClicks / n).toBeLessThan(0.17);
	});
});
