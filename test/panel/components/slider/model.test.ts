import { describe, expect, test } from "bun:test";
import { STRENGTH_UI, UI_TIMINGS } from "@core/constants/ui";
import {
	fitValue,
	keyTarget,
	percentOf,
	snapValue,
	strengthEnergy,
	strengthTicks,
} from "@panel/components/slider/model";

const RANGE = { min: 0, max: 2, step: 0.05 };

describe("slider model", () => {
	test("snaps to the step at the step's precision and clamps", () => {
		expect(snapValue(1.234, RANGE)).toBe(1.25);
		expect(snapValue(5, RANGE)).toBe(2);
		expect(snapValue(-1, RANGE)).toBe(0);
	});

	test("an exact reading is clamped but not snapped", () => {
		expect(fitValue(1.234, true, RANGE)).toBe(1.234);
		expect(fitValue(1.234, false, RANGE)).toBe(1.25);
	});

	test("track percentages clamp and survive an empty range", () => {
		expect(percentOf(1, 0, 2)).toBe("50.000%");
		expect(percentOf(3, 0, 2)).toBe("100.000%");
		expect(percentOf(1, 1, 1)).toBe("0.000%");
	});

	test("keys step fine, coarse and to the ends", () => {
		const coarse = RANGE.step * UI_TIMINGS.sliderCoarseMultiplier;
		expect(keyTarget("ArrowUp", false, 1, RANGE)).toBe(1 + RANGE.step);
		expect(keyTarget("ArrowLeft", true, 1, RANGE)).toBe(1 - coarse);
		expect(keyTarget("PageUp", false, 1, RANGE)).toBe(1 + coarse);
		expect(keyTarget("Home", false, 1, RANGE)).toBe(0);
		expect(keyTarget("End", false, 1, RANGE)).toBe(2);
		expect(keyTarget("a", false, 1, RANGE)).toBeNull();
	});

	test("strength energy is 0 below the glow and 1 at the maximum", () => {
		const max = STRENGTH_UI.glowElo + 1000;
		expect(strengthEnergy(STRENGTH_UI.glowElo - 1, max)).toBe(0);
		expect(strengthEnergy(max, max)).toBe(1);
		expect(strengthEnergy(max, STRENGTH_UI.glowElo)).toBe(0);
	});

	test("strength ticks fall on the tick step inside the range", () => {
		const step = STRENGTH_UI.sliderTickStep;
		const ticks = strengthTicks(step / 2, step * 2);
		expect(ticks.map((t) => t.value)).toEqual([step, step * 2]);
		expect(ticks[1]?.left).toBe("100.000%");
	});
});
