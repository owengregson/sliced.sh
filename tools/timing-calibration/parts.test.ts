// tools/timing-calibration/parts.test.ts — the pure seams of the calibration: the cell keys, the
// recorded-clock rounding, the fit's smoothers, the two-sample distances and the report cells.
import { describe, expect, it } from "bun:test";
import { bandOf, parseControl, tcGroupOf, wideBandOf } from "./common";
import { isotonic, smoothWeighted, viterbi } from "./fit";
import { safeTradeArm } from "./premove-outcomes/arm";
import { recordedMs } from "./sim";
import { auc, capSides, crps, hash32, ks, quantileSorted } from "./stats";
import { f2, pct } from "./verify";

describe("cell keys", () => {
	it("bands, groups and controls", () => {
		expect([599, 600, 1999, 3000, 3400].map(bandOf)).toEqual([600, 600, 1900, 3000, 3000]);
		expect([900, 1000, 1399, 1400, 2999, 3000].map(wideBandOf)).toEqual([
			600, 1000, 1000, 1400, 2600, 3000,
		]);
		expect(tcGroupOf("rapid", "600+5")).toBe("rapid:600+5");
		expect(tcGroupOf("rapid", "1800")).toBe("rapid:other");
		expect(tcGroupOf("blitz", "180+2")).toBe("blitz");
		expect(parseControl("180+2")).toEqual({ baseS: 180, incS: 2 });
		expect(parseControl("1/259200")).toBeNull();
	});
});

describe("the replay's recording", () => {
	it("rounds a release up to chess.com's tenth of a second, never under 0.1 s", () => {
		expect([0, 99, 100, 101, 250].map(recordedMs)).toEqual([100, 100, 100, 200, 300]);
	});

	it("arms nothing without predicted lines", () => {
		expect(safeTradeArm("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", [])).toBeNull();
	});
});

describe("the fit's smoothers", () => {
	it("pool adjacent violators into a non-decreasing fit", () => {
		expect(isotonic([1, 3, 2, 4], [1, 1, 1, 1])).toEqual([1, 2.5, 2.5, 4]);
	});

	it("smooths towards the weighted data and falls back without weight", () => {
		const v = smoothWeighted([0, 1, 0], [1, 1, 1], 0);
		expect(v.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 1, 0]);
		expect(smoothWeighted([5, 5], [0, 0], 1, 0.5)).toEqual([0.5, 0.5]);
	});

	it("finds the cheapest path over the knots, penalising jumps", () => {
		const grid = [0, 1];
		expect(
			viterbi(
				grid,
				[
					[0, 5],
					[5, 0],
				],
				0
			)
		).toEqual([0, 1]);
		expect(
			viterbi(
				grid,
				[
					[0, 5],
					[1, 0],
				],
				10
			)
		).toEqual([0, 0]);
	});
});

describe("distances and choices", () => {
	it("KS, AUC and CRPS on small samples", () => {
		expect(ks([1, 2, 3], [1, 2, 3])).toBe(0);
		expect(ks([1, 2], [3, 4])).toBe(1);
		expect(auc([2, 2], [1, 3])).toBe(0.5);
		expect(auc([], [1])).toBeNaN();
		expect(crps([1000], [1000])).toBe(0);
		expect(quantileSorted([0, 10], 0.25)).toBe(2.5);
	});

	it("caps game-sides per player and time class by a stable hash", () => {
		const rows = ["a", "b", "c"].map((gameId) => ({ player: "p", tc: "blitz", gameId }));
		const kept = capSides(rows, 2).map((r) => r.gameId);
		expect(kept).toHaveLength(2);
		expect(
			capSides([...rows].reverse(), 2)
				.map((r) => r.gameId)
				.sort()
		).toEqual(kept.sort());
		expect(hash32("")).toBe(0x811c9dc5);
	});

	it("formats report cells", () => {
		expect([f2(1.234), f2(undefined), f2(Number.NaN)]).toEqual(["1.23", "–", "–"]);
		expect([pct(0.125), pct(undefined)]).toEqual(["13%", "–"]);
	});
});
