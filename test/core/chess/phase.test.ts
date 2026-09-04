// test/core/chess/phase.test.ts
import { describe, expect, it } from "bun:test";
import { phase } from "@core/chess/phase";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** Full non-pawn material (62) after 11 moves — ply 22 ≥ 20 → middlegame. */
const DEVELOPED_LATE = "r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N2N2/PP2BPPP/R1BQ1RK1 w - - 0 12";
/** Queens off (44) at move 10 — middlegame by material regardless of ply. */
const QUEENLESS = "r1b2rk1/pp2bppp/2n1pn2/3p4/2PP4/2N2N2/PP2BPPP/R1B2RK1 w - - 0 10";
/** Rook + pawns vs pawns (5) → endgame. */
const ROOK_ENDING = "8/5pk1/6p1/8/8/6P1/5PK1/4R3 w - - 0 40";

describe("phase", () => {
	it("classifies three known positions", () => {
		expect(phase(START)).toBe("opening");
		expect(phase(QUEENLESS)).toBe("middlegame");
		expect(phase(ROOK_ENDING)).toBe("endgame");
	});
	it("uses ply to split opening from middlegame at full material", () => {
		expect(phase(DEVELOPED_LATE)).toBe("middlegame");
		expect(phase(START, 19)).toBe("opening");
		expect(phase(START, 20)).toBe("middlegame");
		expect(phase(START, 30)).toBe("middlegame");
	});
	it("derives ply from the fullmove number and side to move", () => {
		// Move 10 with black to move → ply 19 → still opening at full material.
		expect(phase("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 10")).toBe("opening");
		// Move 11 with white to move → ply 20 → middlegame.
		expect(phase("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 11")).toBe("middlegame");
	});
	it("treats the endgame threshold as inclusive at 26", () => {
		// White Q+B+B (15) vs black R+B+B (11) = 26 → endgame.
		expect(phase("1bbk4/8/8/8/8/8/8/QBBK3r w - - 0 50")).toBe("endgame");
		// White Q+R (14) vs black Q+R (14) = 28 → middlegame.
		expect(phase("r2qk3/8/8/8/8/8/8/R2QK3 w - - 0 50")).toBe("middlegame");
	});
	it("returns null on a bad FEN", () => {
		expect(phase("bad fen")).toBeNull();
	});
});
