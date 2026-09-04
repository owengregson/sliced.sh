// test/core/engine/snapshot.test.ts
import { describe, expect, it } from "bun:test";
import { sideToMove } from "@core/chess/fen";
import { pvToSan } from "@core/chess/san";
import { LIMITS } from "@core/constants/limits";
import { toEvalSnapshot, updateToSnapshot, winProb } from "@core/engine/snapshot";
import type { AnalysisResult, AnalysisUpdate } from "@core/engine/types";
import type { Eval, EvalLine } from "@typedefs/engine";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";

// Warm chess.js (FEN validation + SAN) once so first-use cost is not billed to a 5 ms test.
sideToMove(START);
pvToSan(START, ["e2e4", "e7e5", "g1f3"]);

function line(
	multipv: number,
	score: Eval,
	pvUci: string[],
	extra: Partial<EvalLine> = {}
): EvalLine {
	return { multipv, score, depth: 12, pvUci, pvSan: [], ...extra };
}

function result(fen: string, lines: EvalLine[], bestmove: string | null = "e2e4"): AnalysisResult {
	const request = { id: "r1", fen, multiPv: lines.length, limit: { movetimeMs: 500 } };
	const final: AnalysisUpdate = {
		id: "r1",
		depth: 12,
		seldepth: 18,
		lines,
		nodes: 12345,
		nps: 50000,
		timeMs: 250,
		complete: true,
	};
	return { id: "r1", bestmove, final, status: "complete", request };
}

describe("winProb", () => {
	it("is the lichess logistic with LIMITS.winProbK", () => {
		expect(LIMITS.winProbK).toBeCloseTo(0.00368208, 10);
		expect(winProb(0)).toBe(0.5);
		expect(winProb(100)).toBeCloseTo(1 / (1 + Math.exp(-0.368208)), 10);
		expect(winProb(-100)).toBeCloseTo(1 - winProb(100), 10);
	});
});

describe("toEvalSnapshot", () => {
	it("cp +34 white to move → evalBar ≈ +0.06, scoreText +0.34", () => {
		const s = toEvalSnapshot(result(START, [line(1, { cp: 34 }, ["e2e4", "e7e5"])]), START);
		expect(s.evalBar).toBeCloseTo(0.0625, 2);
		expect(s.scoreText).toBe("+0.34");
		expect(s.sideToMove).toBe("w");
		expect(s.bestmove).toBe("e2e4");
		expect(s.depth).toBe(12);
		expect(s.seldepth).toBe(18);
		expect(s.nps).toBe(50000);
		expect(s.nodes).toBe(12345);
		expect(s.timeMs).toBe(250);
		expect(s.requestId).toBe("r1");
		expect(s.fen).toBe(START);
	});
	it("mate −2 black to move → M2 white POV and evalBar +1", () => {
		const s = toEvalSnapshot(result(AFTER_E4, [line(1, { mate: -2 }, ["e7e5"])], "e7e5"), AFTER_E4);
		expect(s.scoreText).toBe("M2");
		expect(s.evalBar).toBe(1);
		expect(s.lines[0]?.score).toEqual({ mate: 2 });
	});
	it("mate +3 black to move → -M3 and evalBar −1", () => {
		const s = toEvalSnapshot(result(AFTER_E4, [line(1, { mate: 3 }, ["e7e5"])], "e7e5"), AFTER_E4);
		expect(s.scoreText).toBe("-M3");
		expect(s.evalBar).toBe(-1);
	});
	it("mate 0 (side to move is mated) → the other side has won, score stays {mate: 0}", () => {
		const white = toEvalSnapshot(result(START, [line(1, { mate: 0 }, [])], null), START);
		expect(white.evalBar).toBe(-1);
		expect(white.scoreText).toBe("-M0");
		expect(Object.is(white.lines[0]?.score.mate, 0)).toBe(true);
		const black = toEvalSnapshot(result(AFTER_E4, [line(1, { mate: 0 }, [])], null), AFTER_E4);
		expect(black.evalBar).toBe(1);
		expect(black.scoreText).toBe("M0");
		expect(Object.is(black.lines[0]?.score.mate, 0)).toBe(true);
	});
	it("cp +50 black to move → -0.50 (white POV), negative evalBar", () => {
		const s = toEvalSnapshot(result(AFTER_E4, [line(1, { cp: 50 }, ["e7e5"])], "e7e5"), AFTER_E4);
		expect(s.scoreText).toBe("-0.50");
		expect(s.evalBar).toBeLessThan(0);
		expect(s.evalBar).toBeCloseTo(-(2 * winProb(50) - 1), 10);
		expect(s.lines[0]?.score).toEqual({ cp: -50 });
	});
	it("cp 0 → 0.00, evalBar 0", () => {
		const s = toEvalSnapshot(result(START, [line(1, { cp: 0 }, ["e2e4"])]), START);
		expect(s.scoreText).toBe("0.00");
		expect(s.evalBar).toBe(0);
	});
	it("flips WDL to white POV when black is to move", () => {
		const s = toEvalSnapshot(
			result(AFTER_E4, [line(1, { cp: 20 }, ["e7e5"], { wdl: [300, 500, 200] })], "e7e5"),
			AFTER_E4
		);
		expect(s.wdl).toEqual({ w: 200, d: 500, l: 300 });
		const w = toEvalSnapshot(
			result(START, [line(1, { cp: 20 }, ["e2e4"], { wdl: [300, 500, 200] })]),
			START
		);
		expect(w.wdl).toEqual({ w: 300, d: 500, l: 200 });
		expect(toEvalSnapshot(result(START, [line(1, { cp: 20 }, ["e2e4"])]), START).wdl).toBeUndefined();
	});
	it("converts every line (white POV, SAN via pvToSan when the line has none)", () => {
		const s = toEvalSnapshot(
			result(START, [
				line(1, { cp: 34 }, ["e2e4", "e7e5", "g1f3"]),
				line(2, { cp: 20 }, ["d2d4", "d7d5"], { pvSan: ["d4", "d5"] }),
				line(3, { mate: -4 }, ["f2f3"]),
			]),
			START
		);
		expect(s.lines.map((l) => l.multipv)).toEqual([1, 2, 3]);
		expect(s.lines[0]?.pvSan).toEqual(["e4", "e5", "Nf3"]);
		expect(s.lines[0]?.pvUci).toEqual(["e2e4", "e7e5", "g1f3"]);
		expect(s.lines[0]?.scoreText).toBe("+0.34");
		expect(s.lines[1]?.pvSan).toEqual(["d4", "d5"]);
		expect(s.lines[1]?.scoreText).toBe("+0.20");
		expect(s.lines[2]?.scoreText).toBe("-M4");
		expect(s.lines[2]?.score).toEqual({ mate: -4 });
		expect(s.lines[0]?.depth).toBe(12);
	});
	it("stops SAN at the first illegal PV move", () => {
		const s = toEvalSnapshot(result(START, [line(1, { cp: 0 }, ["e2e4", "e2e4", "d2d4"])]), START);
		expect(s.lines[0]?.pvSan).toEqual(["e4"]);
	});
	it("has no score before any line arrived", () => {
		const s = toEvalSnapshot(result(START, [], null), START);
		expect(s.evalBar).toBe(0);
		expect(s.scoreText).toBe("");
		expect(s.lines).toEqual([]);
		expect(s.bestmove).toBeNull();
	});
	it("treats an unparsable FEN as white to move", () => {
		const s = toEvalSnapshot(result("garbage", [line(1, { cp: 34 }, ["e2e4"])]), "garbage");
		expect(s.scoreText).toBe("+0.34");
		expect(s.sideToMove).toBe("w");
		expect(s.lines[0]?.pvSan).toEqual([]);
	});
	it("updateToSnapshot builds the same shape from a live update (no bestmove)", () => {
		const r = result(START, [line(1, { cp: 34 }, ["e2e4"])]);
		const s = updateToSnapshot(r.final, START);
		expect(s.bestmove).toBeNull();
		expect(s.scoreText).toBe("+0.34");
		expect(s.requestId).toBe("r1");
	});
});
