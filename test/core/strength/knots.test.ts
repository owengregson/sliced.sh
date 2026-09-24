// test/core/strength/knots.test.ts
import { describe, expect, it } from "bun:test";
import { interpolateKnots } from "@core/strength/knots";

const KNOTS = [
	[1000, 0.5],
	[2000, 0.1],
	[3000, 0.3],
] as const;

describe("interpolateKnots", () => {
	it("is flat outside the table", () => {
		expect(interpolateKnots(500, KNOTS, 9)).toBe(0.5);
		expect(interpolateKnots(1000, KNOTS, 9)).toBe(0.5);
		expect(interpolateKnots(3000, KNOTS, 9)).toBe(0.3);
		expect(interpolateKnots(4000, KNOTS, 9)).toBe(0.3);
	});

	it("is linear between neighbouring knots", () => {
		expect(interpolateKnots(1500, KNOTS, 9)).toBeCloseTo(0.3, 12);
		expect(interpolateKnots(2000, KNOTS, 9)).toBeCloseTo(0.1, 12);
		expect(interpolateKnots(2500, KNOTS, 9)).toBeCloseTo(0.2, 12);
	});

	it("answers `empty` for a table with no knots", () => {
		expect(interpolateKnots(1500, [], 1)).toBe(1);
		expect(interpolateKnots(1500, [], 0)).toBe(0);
	});
});
