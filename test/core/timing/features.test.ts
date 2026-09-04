// test/core/timing/features.test.ts — Step 1: Appendix D §2 features.
import { describe, expect, it } from "bun:test";
import {
	computeFeatures,
	eloZ,
	featuresToRecord,
	parseTimeControl,
	tcClass,
} from "@core/timing/features";
import { AFTER_EXD5, ctx, line, MIDDLEGAME_FEN, START_FEN } from "./helpers";

describe("elo_z", () => {
	it("maps 800 → −1 and 2500 → +1, clamped", () => {
		expect(eloZ(800)).toBe(-1);
		expect(eloZ(2500)).toBe(1);
		expect(eloZ(1650)).toBe(0);
		expect(eloZ(400)).toBe(-1);
		expect(eloZ(3200)).toBe(1);
	});
});

describe("tc_class", () => {
	it("classifies by base + 40·inc", () => {
		expect(tcClass(...parseTimeControl("180+0"))).toBe("blitz");
		expect(tcClass(...parseTimeControl("60+0"))).toBe("bullet");
		expect(tcClass(...parseTimeControl("600+5"))).toBe("rapid");
		expect(tcClass(...parseTimeControl("1800+0"))).toBe("classical");
		expect(tcClass(...parseTimeControl("120+1"))).toBe("bullet");
	});
	it("is untimed without a clock", () => {
		expect(tcClass(0, 0)).toBe("untimed");
		expect(tcClass(...parseTimeControl("-"))).toBe("untimed");
		expect(tcClass(...parseTimeControl("untimed"))).toBe("untimed");
	});
});

describe("computeFeatures", () => {
	it("decisiveness for best +200 / second −100 equals ln(1 + 300/25)", () => {
		const f = computeFeatures(
			ctx({ lines: [line(1, 200, "d2d4"), line(2, -100, "a2a4"), line(3, -150, "h3h4")] })
		);
		expect(f.decisiveness).toBeCloseTo(Math.log(1 + 300 / 25), 10);
		expect(f.n_reasonable).toBe(1);
		expect(f.is_forced).toBe(1);
	});
	it("n_reasonable counts lines within 40 cp of the best (min 1)", () => {
		const f = computeFeatures(
			ctx({
				lines: [line(1, 50, "d2d4"), line(2, 20, "a2a4"), line(3, 10, "b1a3"), line(4, 5, "h3h4")],
			})
		);
		expect(f.n_reasonable).toBe(3);
		expect(f.ln_n_reasonable).toBeCloseTo(Math.log(3), 10);
		expect(computeFeatures(ctx({ lines: [] })).n_reasonable).toBe(1);
	});
	it("is_recapture when the opponent just captured on the destination square", () => {
		const f = computeFeatures(
			ctx({
				fen: AFTER_EXD5,
				myColor: "b",
				ply: 3,
				moves: ["e2e4", "d7d5", "e4d5"],
				chosenMove: "d8d5",
				lines: [line(1, -10, "d8d5"), line(2, -60, "g8f6")],
			})
		);
		expect(f.is_recapture).toBe(1);
		expect(f.is_capture).toBe(1);
		expect(f.premove_eligible).toBe(1);
		expect(f.chosen_rank).toBe(0);
		expect(f.chosen_gap).toBe(0);
	});
	it("ponder_hit when the opponent played the expected reply", () => {
		const hit = computeFeatures(ctx({ moves: ["e2e4", "e7e5"], expectedOppReply: "e7e5" }));
		const miss = computeFeatures(ctx({ moves: ["e2e4", "e7e5"], expectedOppReply: "c7c5" }));
		expect(hit.ponder_hit).toBe(1);
		expect(miss.ponder_hit).toBe(0);
	});
	it("in_book only in the first 16 plies when playing the engine's best move", () => {
		expect(computeFeatures(ctx({ fen: START_FEN, ply: 0, chosenMove: "d2d4" })).in_book).toBe(1);
		expect(computeFeatures(ctx({ fen: START_FEN, ply: 0, chosenMove: "a2a4" })).in_book).toBe(0);
		expect(computeFeatures(ctx({ ply: 24 })).in_book).toBe(0);
	});
	it("clock-derived features", () => {
		const f = computeFeatures(ctx({ myClockMs: 60_000, oppClockMs: 120_000 }));
		expect(f.tc).toBe("blitz");
		expect(f.log_base_eff).toBeCloseTo(Math.log(180), 10);
		expect(f.pressure).toBeCloseTo(60 / 180, 10);
		expect(f.clock_ratio).toBeCloseTo(Math.log(61 / 121), 10);
		expect(f.clock_s).toBe(60);
		expect(f.log_clock).toBeCloseTo(Math.log(60), 10);
	});
	it("untimed games condition as classical with a virtual clock and no pressure", () => {
		const f = computeFeatures(ctx({ baseSec: 0, incSec: 0, myClockMs: 0, oppClockMs: 0 }));
		expect(f.tc).toBe("untimed");
		expect(f.pressure).toBe(1);
		expect(f.clock_s).toBe(1800);
		expect(f.base_eff).toBe(1800);
	});
	it("swing_bad / swing_good from the eval before the opponent's move", () => {
		const bad = computeFeatures(ctx({ evalBeforeOppMove: 120 })); // now +20 → swing +100
		expect(bad.swing_bad).toBeCloseTo(Math.log(1 + 100 / 50), 10);
		expect(bad.swing_good).toBe(0);
		const good = computeFeatures(ctx({ evalBeforeOppMove: -80 }));
		expect(good.swing_good).toBeCloseTo(Math.log(1 + 100 / 50), 10);
		expect(computeFeatures(ctx({ evalBeforeOppMove: null })).swing_bad).toBe(0);
	});
	it("eval, phase, material and legal-move features", () => {
		const f = computeFeatures(ctx());
		expect(f.eval_cp).toBe(20);
		expect(f.eval_abs).toBeCloseTo(Math.log(1 + 20 / 100), 10);
		expect(f.eval_sign).toBeCloseTo(Math.tanh(20 / 300), 10);
		expect(f.phase).toBe("middlegame");
		expect(f.phase_mid).toBe(1);
		expect(f.ply_sq).toBeCloseTo((24 / 40) ** 2, 10);
		expect(f.n_legal).toBeGreaterThan(Math.log(20));
		expect(f.dist).toBe(2);
		expect(f.from).toBe("d2");
		expect(f.to).toBe("d4");
		expect(f.material_imb).toBe(0);
		expect(f.non_pawn_pieces).toBe(14);
		expect(f.pawns).toBe(16);
	});
	it("opponent pace relative to the allocation, disabled under 20 s", () => {
		const f = computeFeatures(ctx({ oppThinkMsHistory: [200, 200, 200] }));
		expect(f.opp_pace).toBeLessThan(0);
		expect(f.opp_last).toBeCloseTo(Math.log(0.4), 10);
		expect(computeFeatures(ctx({ myClockMs: 10_000, oppThinkMsHistory: [200] })).opp_pace).toBe(0);
		expect(computeFeatures(ctx({ oppThinkMsHistory: [] })).opp_pace).toBe(0);
	});
	it("chosen move outside the MultiPV gets rank k and the worst-line gap", () => {
		const f = computeFeatures(ctx({ chosenMove: "g1h1" }));
		expect(f.chosen_rank).toBe(4);
		expect(f.chosen_gap).toBeCloseTo(Math.log(1 + 50 / 25), 10);
	});
	it("mates map through cpEquivalent", () => {
		const f = computeFeatures(
			ctx({
				fen: MIDDLEGAME_FEN,
				lines: [
					{ multipv: 1, score: { mate: 2 }, depth: 10, pvUci: ["d2d4"], pvSan: [] },
					line(2, 100, "a2a4"),
				],
			})
		);
		expect(f.eval_cp).toBe(1970);
	});
	it("asRecord exposes only numbers", () => {
		const r = featuresToRecord(computeFeatures(ctx()));
		for (const v of Object.values(r)) expect(typeof v).toBe("number");
		expect(r.tc_blitz).toBe(1);
		expect(r.phase_middlegame).toBe(1);
		expect(Object.keys(r).length).toBeGreaterThanOrEqual(25);
	});
});
