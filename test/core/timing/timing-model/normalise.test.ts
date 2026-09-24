import { describe, expect, it } from "bun:test";
import { TIMING_CONSTANTS as C } from "@core/timing/constants";
import type { MoveBudget } from "@core/timing/move-budget";
import {
	floorFor,
	guardPremove,
	normaliseSample,
	PHYSICAL_FLOOR_S,
} from "@core/timing/timing-model/normalise";

const budget = (targetSec: number): MoveBudget => ({
	allocationSec: targetSec,
	targetSec,
	capSec: 60,
	distributionCapSec: 60,
	effort: 1,
	recognition: 0.5,
	complexity: 0.5,
	recognitionCapSec: 60,
});

describe("normaliseSample", () => {
	it("rescales a normal sample by budget over the head mean", () => {
		const why: string[] = [];
		const out = normaliseSample(
			{
				sample: { tSec: 4, mode: "normal", why: [] },
				rawMedian: 2,
				rawMean: 4,
				budget: budget(2),
				sGame: 0,
				moveTimeScale: 1,
				untimed: false,
			},
			why
		);
		expect(out.comp).toBeCloseTo(0.5, 12);
		expect(out.tSec).toBeCloseTo(2, 12);
		expect(out.median).toBeCloseTo(1, 12);
		expect(out.headSampleSec).toBe(4);
		expect(why.at(-1)).toStartWith("move budget 2.00 s");
	});

	it("compacts an execution-inclusive sample the allocation cannot support", () => {
		const why: string[] = [];
		const out = normaliseSample(
			{
				sample: { tSec: 1, mode: "normal", includesExecution: true, why: [] },
				rawMedian: 1,
				rawMean: 1,
				budget: budget(0),
				sGame: 0,
				moveTimeScale: 1,
				untimed: false,
			},
			why
		);
		expect(out.mode).toBe("instant");
		expect(out.tSec).toBeCloseTo(PHYSICAL_FLOOR_S * 1.5, 12);
		expect(why[0]).toContain("compact execution window");
	});

	it("floors normal moves at minNormalMs and every other mode at the physical floor", () => {
		expect(floorFor("normal")).toBe(Math.max(C.minNormalMs / 1000, PHYSICAL_FLOOR_S));
		expect(floorFor("instant")).toBe(PHYSICAL_FLOOR_S);
	});
});

describe("guardPremove", () => {
	const earned = { premove_eligible: 1, ponder_hit: 1, opp_is_bot: 0 };
	it("keeps an earned premove and adds the submit penalty", () => {
		const out = guardPremove({ tSec: 0.05, mode: "premove" }, earned, false, []);
		expect(out).toEqual({ tSec: 0.05 + C.premove.penaltyS, mode: "premove" });
	});

	it("turns an unearned or forbidden premove into an instant reply", () => {
		for (const [f, forbid] of [
			[{ ...earned, ponder_hit: 0 }, false],
			[earned, true],
		] as const) {
			const why: string[] = [];
			const out = guardPremove({ tSec: C.premove.maxS, mode: "premove" }, f, forbid, why);
			expect(out.mode).toBe("instant");
			expect(out.tSec).toBeCloseTo(C.instant.minS + C.instant.rangeS, 12);
			expect(why).toContain("no premove entered → instant");
		}
	});
});
