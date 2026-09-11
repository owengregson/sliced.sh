import { describe, expect, it } from "bun:test";
import { selectMove } from "@core/strength/move-selector";
import { compareLines, moveQuality, rankedLines } from "@core/strength/quality";
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
			[{ ...second, depth: 18 }, "depth-mismatch"],
		] as const) {
			const result = moveQuality([best, chosen], chosen);
			expect(result.quality.eligible).toBe(false);
			expect(result.quality.reason).toBe(reason);
			expect(result.cpLoss).toBeUndefined();
		}
		expect(moveQuality([best], best).quality.reason).toBe("forced");
		expect(moveQuality([best, { ...best, multipv: 2 }], best).quality.candidates).toBe(1);
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
		const chosen = selectMove(lines, ctx());
		expect(chosen.source).toBe("mate");
		expect(chosen.cpLoss).toBeUndefined();
		expect(chosen.quality?.reason).toBe("mate");
	});
});
