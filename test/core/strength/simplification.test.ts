import { describe, expect, it } from "bun:test";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { heuristicPriorDetailed } from "@core/strength/prior";
import { simplificationFactors } from "@core/strength/simplification";
import { ctx, line } from "./helpers";

// Two extra pawns remain after Rxd5 Kxd5; the quiet rook move keeps the pieces on.
const FEN = "8/8/4k3/3r4/8/8/PP6/3RK3 w - - 0 40";
const TRADE = line(FEN, "d1d5", { cp: 500 }, 1, ["e6d5"]);
const QUIET = line(FEN, "d1c1", { cp: 500 }, 2);
const LINES = [TRADE, QUIET];
const POLICY: PolicyResult = {
	moves: [
		["d1d5", 0.5],
		["d1c1", 0.5],
	],
	wdl: [0, 0.1, 0.9],
	size: "79m",
};

describe("safe endgame simplification", () => {
	it("modestly prefers an equal piece trade while two extra pawns remain, for either color", () => {
		expect(simplificationFactors(FEN, LINES).get("d1d5")).toBe(1.25);
		expect(simplificationFactors(FEN, LINES).has("d1c1")).toBe(false);
		const black = "3rk3/pp6/8/8/3R4/4K3/8/8 b - - 0 40";
		expect(
			simplificationFactors(black, [line(black, "d8d4", { cp: 500 }, 1, ["e3d4"])]).get("d8d4")
		).toBe(1.25);
	});
	it("recognizes a quiet offer only when the short PV completes the exchange", () => {
		const fen = "7k/8/8/8/r7/4K3/PP6/3R4 w - - 0 40";
		const offer = line(fen, "d1d4", { cp: 500 }, 1, ["a4d4", "e3d4"]);
		expect(simplificationFactors(fen, [offer]).get("d1d4")).toBe(1.25);
		expect(simplificationFactors(fen, [{ ...offer, pvUci: offer.pvUci.slice(0, 2) }]).size).toBe(0);
		expect(simplificationFactors(fen, [{ ...offer, pvUci: ["d1d4", "h8h7", "e3e4"] }]).size).toBe(0);
	});
	it("tapers for a smaller advantage, engine loss, and partial removal of opposing pieces", () => {
		expect(simplificationFactors(FEN, [{ ...TRADE, score: { cp: 375 } }]).get("d1d5")).toBeCloseTo(
			1.125
		);
		expect(
			simplificationFactors(FEN, [{ ...TRADE, score: { cp: 450 } }, QUIET]).get("d1d5")
		).toBeCloseTo(1 + 0.25 / 3);
		const fen = "7r/8/4k3/3r4/8/8/PP6/R2RK3 w - - 0 40";
		expect(
			simplificationFactors(fen, [line(fen, "d1d5", { cp: 500 }, 1, ["e6d5"])]).get("d1d5")
		).toBeCloseTo(1.125);
	});
	it("does not reward trades with a lost win, large cp loss, missing or bounded evidence, or forced mate available", () => {
		for (const score of [{ cp: 0 }, { cp: -200 }, { cp: 250 }, { cp: 425 }, {}, { mate: -5 }])
			expect(simplificationFactors(FEN, [{ ...TRADE, score }, QUIET]).size).toBe(0);
		expect(simplificationFactors(FEN, [{ ...TRADE, bound: "lower" }, QUIET]).size).toBe(0);
		expect(simplificationFactors(FEN, [TRADE, { ...QUIET, score: { mate: 10 } }]).size).toBe(0);
		// Unclipped centipawns: +15 -> +10 is not a harmless exchange.
		expect(
			simplificationFactors(FEN, [
				{ ...TRADE, score: { cp: 1000 } },
				{ ...QUIET, score: { cp: 1500 } },
			]).size
		).toBe(0);
		expect(simplificationFactors(FEN, LINES, "middlegame").size).toBe(0);
	});
	it("requires a material lead and rejects dead positions, pawn trades, sacrifices, and illegal replies", () => {
		for (const fen of [
			"8/8/4k3/3r4/8/8/8/3RK3 w - - 0 40",
			"8/pp6/4k3/3r4/8/8/8/3RK3 w - - 0 40",
			"8/8/4k3/3r4/8/8/8/2BRK3 w - - 0 40",
			"8/8/4k3/3r4/8/8/PP6/3QK3 w - - 0 40",
		])
			expect(simplificationFactors(fen, [line(fen, "d1d5", { cp: 500 }, 1, ["e6d5"])]).size).toBe(0);
		const pawns = "8/8/4k3/3p4/4P3/8/PP6/4K3 w - - 0 40";
		expect(simplificationFactors(pawns, [line(pawns, "e4d5", { cp: 500 }, 1, ["e6d5"])]).size).toBe(
			0
		);
		expect(simplificationFactors(FEN, [{ ...TRADE, pvUci: ["d1d5", "e6d1"] }]).size).toBe(0);
	});
	it("replaces the old endgame multiplier instead of stacking with it", () => {
		const prior = heuristicPriorDetailed(FEN, LINES, ctx({ fen: FEN, phase: "endgame" })).get("d1d5");
		expect(prior?.value).toBe(1.25);
		expect(prior?.terms).toEqual([{ rule: "endgame-simplification", factor: 1.25 }]);
	});
});

describe("simplification selection wiring", () => {
	for (const mode of ["plain", "recognition", "upper"] as const) {
		it(`weights ${mode} Maia proposals once and preserves original Maia telemetry`, () => {
			const rng = createRng(`exchange-${mode}`);
			const proposals: number[][] = [];
			const weighted = rng.weighted;
			rng.weighted = (items, weights) => {
				proposals.push([...weights]);
				return weighted(items, weights);
			};
			// Select intuition in both verification modes so the test observes proposal weights directly.
			rng.chance = () => true;
			const chosen = selectMove(
				LINES,
				ctx({
					fen: FEN,
					phase: "endgame",
					ply: 78,
					maia: POLICY,
					rng,
					targetElo: mode === "upper" ? 3000 : 2000,
					...(mode === "plain" ? {} : { shallowLines: LINES, shallowDepth: 8 }),
				})
			);
			expect((proposals[0]?.[0] ?? 0) / (proposals[0]?.[1] ?? 0)).toBeCloseTo(1.25);
			expect(chosen.maiaProb).toBe(0.5);
			expect(chosen.maiaMeters?.klFromMaia).toBeGreaterThan(0);
			expect(chosen.rationale.join(" ")).toContain("endgame simplification:");
			if (mode === "recognition") {
				const q = 1.25 / 2.25;
				expect(chosen.maiaMeters?.klFromMaia).toBeCloseTo(
					q * Math.log(q / 0.5) + (1 - q) * Math.log((1 - q) / 0.5),
					10
				);
			}
		});
	}
	it("also reaches the non-Maia sampling fallback", () => {
		const rng = createRng("fallback-exchange");
		rng.normal = () => 0;
		const weighted = rng.weighted;
		let ratio = 0;
		rng.weighted = (items, weights) => {
			ratio = (weights[0] ?? 0) / (weights[1] ?? 0);
			return weighted(items, weights);
		};
		const chosen = selectMove(
			LINES,
			ctx({ fen: FEN, phase: "endgame", targetElo: 1500, blunderScale: 0, rng })
		);
		expect(ratio).toBeCloseTo(1.25 ** 0.6);
		expect(chosen.source).toBe("sampled");
	});
	it("leaves full-strength selection on the best engine move", () => {
		const lines = [{ ...QUIET, score: { cp: 510 } }, TRADE];
		for (const targetElo of [3200, 3800]) {
			const chosen = selectMove(
				lines,
				ctx({ fen: FEN, phase: "endgame", targetElo, maia: POLICY, state: createSelectionState() })
			);
			expect(chosen.uci).toBe("d1c1");
			expect(chosen.rationale.join(" ")).not.toContain("endgame simplification:");
		}
	});
});
