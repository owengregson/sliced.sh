// test/core/strength/prior.test.ts
import { describe, expect, it } from "bun:test";
import { createSelectionState } from "@core/strength/move-selector";
import { heuristicPrior } from "@core/strength/prior";
import type { EvalLine } from "@typedefs/engine";
import { ctx, line, START } from "./helpers";

/** After 1.e4 d5 2.exd5 — black to move (ply 3). */
const AFTER_EXD5 = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
/** Italian: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.Nc3 Nf6 — white to move (ply 8). */
const ITALIAN = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5";
/** Both sides castled, queens on, white to move; ply 24 → middlegame. */
const CASTLED = "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 w - - 0 8";
/** White rook f1 free to lift (no f-pawn, knight on e2, e3 pawn keeps the c5 bishop off g1). */
const LIFT = "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B5/2N1P3/PPPPN1PP/R1BQ1RK1 w - - 0 8";
/** a8=Q is quiet (black king h7): the underpromotions are pure underpromotions. */
const PROMO = "8/P6k/8/8/8/8/8/7K w - - 0 1";
/** White queen h1 can check with Qh5+. */
const QCHECK = "4k3/8/8/8/8/8/8/4K2Q w - - 0 1";
/** Rxa8 wins a knight nobody defends (black king e7 is not adjacent). */
const UNDEFENDED = "n7/4k3/8/8/8/8/8/R3K3 w - - 0 1";
/** Same, but the knight on c7 recaptures on a8. */
const DEFENDED = "n7/2n1k3/8/8/8/8/8/R3K3 w - - 0 1";
/** Rook trade Rxd5 Kxd5. */
const TRADE = "8/8/4k3/3r4/8/8/8/3RK3 w - - 0 1";
const KP_ENDGAME = "8/8/4k3/8/8/8/4P3/4K3 w - - 0 40";
/** Italian after 3...Nc6: Bxf7+ is a piece sacrifice. */
const SAC = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";

function priors(
	fen: string,
	moves: Array<[string, number] | [string, number, string[]]>,
	over: Parameters<typeof ctx>[0] = {}
): Map<string, number> {
	const lines: EvalLine[] = moves.map(([uci, cp, pv], i) => line(fen, uci, { cp }, i + 1, pv ?? []));
	return heuristicPrior(fen, lines, ctx({ fen, ...over }));
}

describe("heuristicPrior — Appendix E §3.4 table", () => {
	it("returns 1.0 for neutral moves and for lines whose move is illegal", () => {
		const p = priors(START, [
			["e2e4", 30],
			["d2d4", 20],
			["e2e5", 0],
		]);
		expect(p.get("e2e4")).toBe(1);
		expect(p.get("d2d4")).toBe(1);
		expect(p.get("e2e5")).toBe(1);
		expect(p.size).toBe(3);
	});
	it("recapture on the last captured square ×2.5", () => {
		const p = priors(
			AFTER_EXD5,
			[
				["d8d5", 0],
				["g8f6", -10],
			],
			{ ply: 3, lastMove: "e4d5" }
		);
		expect(p.get("d8d5")).toBeCloseTo(2.5, 12);
		// Without the opponent's last move nothing counts as a recapture.
		const q = priors(AFTER_EXD5, [["d8d5", 0]], { ply: 3 });
		expect(q.get("d8d5")).toBe(1);
	});
	it("check ×1.4 below 1400, ×1.15 from 1400", () => {
		expect(
			priors(QCHECK, [["h1h5", 0]], { targetElo: 1000, phase: "endgame" }).get("h1h5")
		).toBeCloseTo(1.4, 12);
		expect(
			priors(QCHECK, [["h1h5", 0]], { targetElo: 1400, phase: "endgame" }).get("h1h5")
		).toBeCloseTo(1.15, 12);
		// form shifts the effective Elo: 1300 + 150 → 1450.
		expect(
			priors(QCHECK, [["h1h5", 0]], { targetElo: 1300, form: 1, phase: "endgame" }).get("h1h5")
		).toBeCloseTo(1.15, 12);
	});
	it("capture of an undefended piece ×1.8; a defended one gets no bonus", () => {
		expect(priors(UNDEFENDED, [["a1a8", 0]], { phase: "endgame" }).get("a1a8")).toBeCloseTo(1.8, 12);
		expect(priors(DEFENDED, [["a1a8", 0]], { phase: "endgame" }).get("a1a8")).toBe(1);
	});
	it("castling ×1.6 while ply ≤ 30", () => {
		expect(priors(ITALIAN, [["e1g1", 0]], { ply: 8 }).get("e1g1")).toBeCloseTo(1.6, 12);
		expect(priors(ITALIAN, [["e1g1", 0]], { ply: 31, phase: "middlegame" }).get("e1g1")).toBe(1);
	});
	it("developing a minor piece from the back rank ×1.4 while ply ≤ 20", () => {
		const p = priors(START, [
			["g1f3", 0],
			["b1c3", 0],
			["e2e4", 0],
		]);
		expect(p.get("g1f3")).toBeCloseTo(1.4, 12);
		expect(p.get("b1c3")).toBeCloseTo(1.4, 12);
		expect(p.get("e2e4")).toBe(1);
		expect(priors(START, [["g1f3", 0]], { ply: 22, phase: "middlegame" }).get("g1f3")).toBe(1);
	});
	it("pawn push in front of the castled king in the middlegame ×0.6", () => {
		const p = priors(
			CASTLED,
			[
				["g2g3", 0],
				["a2a4", 0],
			],
			{ ply: 24, phase: "middlegame" }
		);
		expect(p.get("g2g3")).toBeCloseTo(0.6, 12);
		expect(p.get("a2a4")).toBe(1);
		expect(priors(CASTLED, [["g2g3", 0]], { ply: 24, phase: "endgame" }).get("g2g3")).toBe(1);
	});
	it("quiet middlegame king move (queens on, not in check) ×0.35", () => {
		expect(priors(CASTLED, [["g1h1", 0]], { ply: 24, phase: "middlegame" }).get("g1h1")).toBeCloseTo(
			0.35,
			12
		);
		expect(priors(CASTLED, [["g1h1", 0]], { ply: 24, phase: "endgame" }).get("g1h1")).toBe(1);
	});
	it("rook lift / rook to a closed file without PV justification ×0.7", () => {
		const p = priors(
			LIFT,
			[
				["f1f3", 0],
				["f1e1", 0],
			],
			{ ply: 24, phase: "middlegame" }
		);
		expect(p.get("f1f3")).toBeCloseTo(0.7, 12);
		expect(p.get("f1e1")).toBeCloseTo(0.7, 12);
		const justified = priors(LIFT, [["f1f3", 0, ["d7d6", "f3g3"]]], { ply: 24, phase: "middlegame" });
		expect(justified.get("f1f3")).toBe(1);
	});
	it("retreating a developed piece to the back rank while ply ≤ 25 ×0.6", () => {
		const p = priors(
			ITALIAN,
			[
				["c4f1", 0],
				["f3g1", 0],
				["c4b3", 0],
			],
			{ ply: 8 }
		);
		expect(p.get("c4f1")).toBeCloseTo(0.6, 12);
		expect(p.get("f3g1")).toBeCloseTo(0.6, 12);
		expect(p.get("c4b3")).toBe(1);
		expect(priors(ITALIAN, [["c4f1", 0]], { ply: 26, phase: "middlegame" }).get("c4f1")).toBe(1);
	});
	it("waiting move a3/h3 with no threat: ×0.7 below 1600, ×1.0 at ≥ 2000, interpolated between", () => {
		expect(priors(START, [["a2a3", 0]], { targetElo: 1000 }).get("a2a3")).toBeCloseTo(0.7, 12);
		expect(priors(START, [["h2h3", 0]], { targetElo: 1599 }).get("h2h3")).toBeCloseTo(0.7, 12);
		expect(priors(START, [["a2a3", 0]], { targetElo: 1800 }).get("a2a3")).toBeCloseTo(0.85, 12);
		expect(priors(START, [["a2a3", 0]], { targetElo: 2000 }).get("a2a3")).toBe(1);
	});
	it("underpromotion ×0.05 (queen promotion untouched)", () => {
		const p = priors(
			PROMO,
			[
				["a7a8q", 900],
				["a7a8n", 0],
				["a7a8r", 500],
			],
			{ phase: "endgame" }
		);
		expect(p.get("a7a8q")).toBe(1);
		expect(p.get("a7a8n")).toBeCloseTo(0.05, 12);
		expect(p.get("a7a8r")).toBeCloseTo(0.05, 12);
	});
	it("piece sacrifice shown by the PV: ×0.5 below 1800, ×0.9 at ≥ 2200, interpolated between", () => {
		const pv = ["e8f7", "d2d3", "g8f6", "b1c3"];
		const at = (targetElo: number) =>
			priors(
				SAC,
				[
					["c4f7", 0, pv],
					["d2d3", 0, ["d7d6", "b1c3", "g8f6"]],
				],
				{ ply: 6, targetElo }
			).get("c4f7");
		// Bxf7+ is also a check (×1.15 at ≥ 1400, ×1.4 below).
		expect(at(1500)).toBeCloseTo(1.15 * 0.5, 12);
		expect(at(2000)).toBeCloseTo(1.15 * 0.7, 12);
		expect(at(2200)).toBeCloseTo(1.15 * 0.9, 12);
		expect(at(1000)).toBeCloseTo(1.4 * 0.5, 12);
		expect(priors(SAC, [["d2d3", 0, ["d7d6", "b1c3", "g8f6"]]], { ply: 6 }).get("d2d3")).toBe(1);
	});
	it("back-and-forth with the same piece ×0.5 unless behind", () => {
		const state = { ...createSelectionState(), previousOwnMoves: ["f3g1"] };
		const p = priors(
			START,
			[
				["g1f3", 20],
				["e2e4", 10],
			],
			{ state }
		);
		expect(p.get("g1f3")).toBeCloseTo(1.4 * 0.5, 12);
		expect(p.get("e2e4")).toBe(1);
		const behind = priors(
			START,
			[
				["g1f3", -80],
				["e2e4", -90],
			],
			{ state }
		);
		expect(behind.get("g1f3")).toBeCloseTo(1.4, 12);
	});
	it("endgame king activation (queens off, ply ≥ 60) ×1.5 from E ≥ 1600", () => {
		const over = { ply: 78, phase: "endgame" as const };
		expect(priors(KP_ENDGAME, [["e1d2", 0]], { ...over, targetElo: 1600 }).get("e1d2")).toBeCloseTo(
			1.5,
			12
		);
		expect(priors(KP_ENDGAME, [["e1d2", 0]], { ...over, targetElo: 1500 }).get("e1d2")).toBe(1);
		expect(
			priors(KP_ENDGAME, [["e1d2", 0]], { ply: 40, phase: "endgame", targetElo: 2000 }).get("e1d2")
		).toBe(1);
	});
});

describe("heuristicPrior — situational modifiers (Appendix E §3.3)", () => {
	it("simplify when ahead: trades ×1.8 at every Elo", () => {
		const moves: Array<[string, number, string[]]> = [
			["d1d5", 400, ["e6d5"]],
			["e1d2", 380, []],
		];
		expect(priors(TRADE, moves, { phase: "endgame", targetElo: 1500 }).get("d1d5")).toBeCloseTo(
			1.8,
			12
		);
		expect(priors(TRADE, moves, { phase: "endgame", targetElo: 1000 }).get("d1d5")).toBeCloseTo(
			1.8,
			12
		);
		// Not ahead → no modifier.
		const level: Array<[string, number, string[]]> = [
			["d1d5", 0, ["e6d5"]],
			["e1d2", -20, []],
		];
		expect(priors(TRADE, level, { phase: "endgame", targetElo: 1500 }).get("d1d5")).toBe(1);
	});
	it("quiet moves in sharp lines ×0.7 when ahead, only from E ≥ 1400", () => {
		const sharp: Array<[string, number, string[]]> = [
			["e2e3", 400, ["e7e5", "d2d4", "e5d4", "c2c3", "d4c3"]],
			["d2d3", 380, ["d7d6"]],
		];
		expect(priors(START, sharp, { targetElo: 1500 }).get("e2e3")).toBeCloseTo(0.7, 12);
		expect(priors(START, sharp, { targetElo: 1500 }).get("d2d3")).toBe(1);
		expect(priors(START, sharp, { targetElo: 1000 }).get("e2e3")).toBe(1);
	});
	it("complicate when behind (E ≥ 1400): checks and captures ×1.4, trades ×0.6", () => {
		const moves: Array<[string, number, string[]]> = [
			["d1d5", -400, ["e6d5"]],
			["e1d2", -420, []],
		];
		expect(priors(TRADE, moves, { phase: "endgame", targetElo: 1500 }).get("d1d5")).toBeCloseTo(
			1.4 * 0.6,
			12
		);
		expect(priors(TRADE, moves, { phase: "endgame", targetElo: 1000 }).get("d1d5")).toBe(1);
		const check: Array<[string, number, string[]]> = [
			["h1h5", -400, []],
			["e1d2", -420, []],
		];
		expect(priors(QCHECK, check, { phase: "endgame", targetElo: 1500 }).get("h1h5")).toBeCloseTo(
			1.15 * 1.4,
			12
		);
	});
});
