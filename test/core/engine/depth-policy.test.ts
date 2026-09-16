import { expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { HUMAN_DEPTH } from "@core/constants/search";
import { automaticDepthForElo, humanDepth } from "@core/engine/depth-policy";

// Owner, 2026-09-15: the small-network curve now ends at the Maia cutoff, where the full network
// takes over (it ended at the former 3200 network switch). The same 6 → 28 ceiling spans 400–3000
// instead of 400–3200, so each rating below the cutoff gets a slightly deeper cap than before.
it("uses the active Elo curve and the maximum setting strictly above the Maia cutoff", () => {
	expect(MAIA.eloMax).toBe(3000);
	for (const [elo, depth] of [
		[400, 6],
		[800, 9],
		[1200, 13],
		[1650, 17],
		[1673, 17],
		[2000, 20],
		[2400, 23],
		[2800, 26],
		[3000, 28],
		[3001, 30],
		[3200, 30],
		[3800, 30],
	])
		expect(automaticDepthForElo(elo!)).toBe(depth!);
	for (let elo = LIMITS.eloMin; elo < LIMITS.eloMax; elo++) {
		expect(automaticDepthForElo(elo + 1)).toBeGreaterThanOrEqual(automaticDepthForElo(elo));
		expect(automaticDepthForElo(elo)).toBeLessThanOrEqual(LIMITS.depthMax);
	}
});

it("bounds malformed and out-of-range targets without using a saved manual depth", () => {
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -20, 0])
		expect(automaticDepthForElo(value)).toBe(LIMITS.depthMin);
	expect(automaticDepthForElo(50_000)).toBe(LIMITS.depthMax);
});

// H4 (2026-09-13): the human-depth frame by the rating Maia is asked about.
it("humanDepth: the HUMAN_DEPTH knots, flat outside, linear and rounded between", () => {
	for (const [elo, depth] of HUMAN_DEPTH) expect(humanDepth(elo)).toBe(depth);
	for (const [elo, depth] of [
		[400, 2],
		[799, 2],
		[1000, 3],
		[1300, 5],
		[1400, 5],
		[1500, 6],
		[1800, 7],
		[2200, 9],
		[2401, 10],
		[2800, 10],
		[2900, 12],
		[3000, 14],
		[3800, 14],
	])
		expect(humanDepth(elo as number)).toBe(depth as number);
	expect(humanDepth(2400)).toBe(LIMITS.featureDepth);
	for (let elo = 400; elo < 3000; elo++)
		expect(humanDepth(elo + 1)).toBeGreaterThanOrEqual(humanDepth(elo));
	for (const value of [Number.NaN, Number.NEGATIVE_INFINITY]) expect(humanDepth(value)).toBe(2);
});
