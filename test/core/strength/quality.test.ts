import { describe, expect, it } from "bun:test";
import { SEARCH_BUDGET } from "@core/constants/search";
import { selectMove } from "@core/strength/move-selector";
import {
	compareLines,
	compareLinesForMerge,
	moveQuality,
	rankedLines,
} from "@core/strength/quality";
import { ctx, line, START } from "./helpers";

describe("comparable selection quality", () => {
	it("ranks and measures raw large cp scores without the policy clamp", () => {
		const lines = [line(START, "d2d4", { cp: 1100 }, 1), line(START, "e2e4", { cp: 2500 }, 2)];
		const chosen = selectMove(lines, ctx({ selectionMode: "engine-elo", engineBestmove: "d2d4" }));
		expect(chosen.rankInLines).toBe(2);
		expect(chosen.cpLoss).toBe(1400);
		expect(chosen.quality).toEqual({ kind: "search", eligible: true, candidates: 2, depth: 20 });
		expect(selectMove(lines, ctx({ targetElo: 3800 })).uci).toBe("e2e4");
	});

	it("does not invent a centipawn difference for mate, bound, missing, shallow, or single-choice scores", () => {
		const best = line(START, "e2e4", { cp: 50 }, 1);
		const second = line(START, "d2d4", { cp: 20 }, 2);
		for (const [chosen, reason] of [
			[{ ...second, score: { mate: 4 } }, "mate"],
			[{ ...second, score: {} }, "unknown"],
			[{ ...second, bound: "upper" as const }, "bound"],
			[{ ...second, depth: 3 }, "shallow"],
			[{ ...second, depth: 20 - SEARCH_BUDGET.qualityDepthTolerance - 1 }, "depth-mismatch"],
		] as const) {
			const result = moveQuality([best, chosen], chosen);
			expect(result.quality.eligible).toBe(false);
			expect(result.quality.reason).toBe(reason);
			expect(result.cpLoss).toBeUndefined();
		}
		expect(moveQuality([best], best).quality.reason).toBe("forced");
		expect(moveQuality([best, { ...best, multipv: 2 }], best).quality.candidates).toBe(1);
	});

	// §7 A2 (2026-09-13): the extra referee frame is a few plies shallower than the main one; the
	// session's diagnostics used to go blind on exactly the moves it enabled.
	it("accepts a depth difference inside qualityDepthTolerance as a comparable sample", () => {
		const best = line(START, "e2e4", { cp: 50 }, 1);
		const second = line(START, "d2d4", { cp: 20 }, 2);
		for (const delta of [1, SEARCH_BUDGET.qualityDepthTolerance]) {
			const shallower = { ...second, depth: 20 - delta };
			const result = moveQuality([best, shallower], shallower);
			expect(result.quality).toEqual({
				kind: "search",
				eligible: true,
				candidates: 2,
				depth: 20 - delta,
			});
			expect(result.cpLoss).toBe(30);
		}
		const tooFar = { ...second, depth: 20 - SEARCH_BUDGET.qualityDepthTolerance - 1 };
		expect(moveQuality([best, tooFar], tooFar).quality.reason).toBe("depth-mismatch");
		// both depths must still clear `minDepth`: shallow wins over the tolerance
		const shallow = { ...second, depth: 5 };
		expect(moveQuality([{ ...best, depth: 7 }, shallow], shallow).quality.reason).toBe("shallow");
	});

	it("sorts shorter wins and longer forced losses correctly without mixing mate and cp", () => {
		const lines = [
			line(START, "e2e4", { mate: -1 }, 1),
			line(START, "d2d4", { cp: 2500 }, 2),
			line(START, "g1f3", { mate: 5 }, 3),
			line(START, "b1c3", { mate: -5 }, 4),
			line(START, "c2c4", { mate: 2 }, 5),
		];
		expect([...lines].sort(compareLines).map((l) => l.score)).toEqual([
			{ mate: 2 },
			{ mate: 5 },
			{ cp: 2500 },
			{ mate: -5 },
			{ mate: -1 },
		]);
		expect(rankedLines(lines)).toHaveLength(5);
		expect(rankedLines(lines).map((l) => l.score)).toEqual(
			[...lines].sort(compareLines).map((l) => l.score)
		);
		const chosen = selectMove(lines, ctx());
		expect(chosen.source).toBe("mate");
		expect(chosen.cpLoss).toBeUndefined();
		expect(chosen.quality?.reason).toBe("mate");
	});
});

// §7 A1 (2026-09-13): a pool that mixes the main referee frame with the shallower extra
// `searchmoves` frame. The reference is always the main frame's best; ties go to the deeper line.
describe("rankedLines over a merged pool", () => {
	const main = [
		line(START, "e2e4", { cp: 30 }, 1),
		line(START, "d2d4", { cp: 20 }, 2),
		line(START, "g1f3", { cp: 10 }, 3),
		line(START, "c2c4", { cp: 0 }, 4),
	];
	const shallower = (uci: string, cp: number, multipv: number) => ({
		...line(START, uci, { cp }, multipv),
		depth: 18,
	});

	it("compareLinesForMerge: deeper wins inside the tie band, score outside it, classes as before", () => {
		const deep = line(START, "e2e4", { cp: 30 }, 1);
		const inBand = shallower("b1c3", 30 + SEARCH_BUDGET.mergeTieCp, 5);
		const outOfBand = shallower("a2a3", 30 + SEARCH_BUDGET.mergeTieCp + 1, 6);
		expect(compareLinesForMerge(deep, inBand)).toBeLessThan(0);
		expect(compareLinesForMerge(inBand, deep)).toBeGreaterThan(0);
		expect(compareLinesForMerge(deep, outOfBand)).toBeGreaterThan(0);
		// same depth: exactly the engine order
		const same = line(START, "d2d4", { cp: 40 }, 2);
		expect(compareLinesForMerge(deep, same)).toBe(compareLines(deep, same));
		// a shallow mate still outranks a deep centipawn line
		const mate = shallower("h2h4", 0, 7);
		expect(compareLinesForMerge({ ...mate, score: { mate: 3 } }, deep)).toBeLessThan(0);
	});

	it("an optimistic shallow extra line never becomes the reference", () => {
		const optimistic = shallower("b1c3", 99, 5);
		const ranked = rankedLines([...main, optimistic]);
		expect(ranked[0]?.pvUci[0]).toBe("e2e4");
		expect(ranked[1]?.pvUci[0]).toBe("b1c3");
		expect(ranked.map((l) => l.pvUci[0])).toEqual(["e2e4", "b1c3", "d2d4", "g1f3", "c2c4"]);
		// and so the loss of every main-frame line is measured against the main best, not the 99
		const second = main[1] as (typeof main)[number];
		expect(moveQuality([...main, optimistic], second).cpLoss).toBe(10);
		expect(moveQuality([...main, optimistic], optimistic).cpLoss).toBe(0);
		expect(moveQuality([...main, optimistic], optimistic).quality.eligible).toBe(true);
	});

	it("a shallow line inside the tie band ranks below the deeper line it ties with", () => {
		const tied = shallower("b1c3", 20 + SEARCH_BUDGET.mergeTieCp, 5);
		expect(rankedLines([...main, tied]).map((l) => l.pvUci[0])).toEqual([
			"e2e4",
			"d2d4",
			"b1c3",
			"g1f3",
			"c2c4",
		]);
	});

	it("the primary frame is the frame of the first line, whichever is deeper", () => {
		// an extra frame that happens to be deeper than the main one still does not take rank 1
		const deeperExtra = { ...line(START, "b1c3", { cp: 45 }, 5), depth: 24 };
		expect(rankedLines([...main, deeperExtra])[0]?.pvUci[0]).toBe("e2e4");
		// a shallow *mate* from the extra frame is a mate: it is the reference
		const mate = { ...shallower("h2h4", 0, 6), score: { mate: 2 } };
		expect(rankedLines([...main, mate])[0]?.pvUci[0]).toBe("h2h4");
	});
});
