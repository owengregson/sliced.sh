import { describe, expect, it } from "bun:test";
import { EXPECTED_POINTS } from "@core/constants/review";
import {
	byRating,
	expectedPoints,
	negateScore,
	ratingProgress,
} from "@core/engine/expected-points";

describe("expectedPoints", () => {
	it("is even at 0.00, symmetric, and certain for mates", () => {
		expect(expectedPoints({ cp: 0 })).toBeCloseTo(0.5, 12);
		const up = expectedPoints({ cp: 150 }) ?? Number.NaN;
		const down = expectedPoints({ cp: -150 }) ?? Number.NaN;
		expect(up + down).toBeCloseTo(1, 12);
		expect(expectedPoints({ mate: 7 })).toBe(1);
		expect(expectedPoints({ mate: -1 })).toBe(0);
	});

	it("abstains on scores that mean nothing", () => {
		expect(expectedPoints({})).toBeNull();
		expect(expectedPoints({ mate: 0 })).toBeNull();
		expect(expectedPoints({ cp: Number.NaN })).toBeNull();
		expect(expectedPoints({ mate: 1.5 })).toBeNull();
	});

	it("converts the same advantage into more points for a stronger player", () => {
		const novice = expectedPoints({ cp: 200 }, 800) ?? 0;
		const reference = expectedPoints({ cp: 200 }) ?? 0;
		const expert = expectedPoints({ cp: 200 }, 2400) ?? 0;
		expect(novice).toBeLessThan(reference);
		expect(expert).toBeGreaterThan(reference);
		expect(expectedPoints({ cp: 200 }, EXPECTED_POINTS.referenceRating)).toBe(reference);
	});

	it("keeps the slope inside its bounds for extreme ratings", () => {
		expect(expectedPoints({ cp: 200 }, -5_000)).toBe(expectedPoints({ cp: 200 }, 100));
		expect(expectedPoints({ cp: 200 }, 9_000)).toBe(expectedPoints({ cp: 200 }, 3_500));
	});
});

describe("rating generosity", () => {
	it("interpolates between the novice and expert thresholds", () => {
		expect(ratingProgress(EXPECTED_POINTS.noviceRating - 100)).toBe(0);
		expect(ratingProgress(EXPECTED_POINTS.expertRating + 100)).toBe(1);
		const middle = (EXPECTED_POINTS.noviceRating + EXPECTED_POINTS.expertRating) / 2;
		expect(byRating(0.1, 0.2, middle)).toBeCloseTo(0.15, 12);
		// No rating is the reference rating, not the novice end.
		expect(byRating(0.1, 0.2, undefined)).toBe(byRating(0.1, 0.2, EXPECTED_POINTS.referenceRating));
	});

	it("negates centipawns and mates", () => {
		expect(negateScore({ cp: 35 })).toEqual({ cp: -35 });
		expect(negateScore({ mate: -3 })).toEqual({ mate: 3 });
		expect(expectedPoints(negateScore({}))).toBeNull();
	});
});
