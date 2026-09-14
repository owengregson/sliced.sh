import { describe, expect, it } from "bun:test";
import { boardEffectsFor, squaresBetween, winnableTargets } from "@core/chess/board-effects";
import { loadPosition } from "@core/chess/fen";
import type { BoardEffect } from "@core/constants/board-effects";
import { BOARD_EFFECT_LIMITS } from "@core/constants/board-effects";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** `kind from→to` strings, for readable expectations. */
function rays(fen: string, uci: string): string[] {
	return boardEffectsFor({ fen, uci }).map((e: BoardEffect) => `${e.kind} ${e.from}${e.to}`);
}

describe("squaresBetween", () => {
	it("walks a rank, a file and a diagonal, and refuses anything else", () => {
		expect(squaresBetween("a1", "d1")).toEqual(["b1", "c1"]);
		expect(squaresBetween("d1", "d4")).toEqual(["d2", "d3"]);
		expect(squaresBetween("a1", "d4")).toEqual(["b2", "c3"]);
		expect(squaresBetween("d4", "a1")).toEqual(["c3", "b2"]);
		expect(squaresBetween("a1", "b1")).toEqual([]);
		expect(squaresBetween("a1", "a1")).toEqual([]);
		expect(squaresBetween("a1", "c2")).toEqual([]);
	});
});

describe("winnableTargets", () => {
	it("takes an undefended piece and one attacked by something cheaper, and leaves the rest", () => {
		// Black to move; the white knight on c7 hits the a8 rook (cheaper attacker) and the
		// undefended e6 bishop. The d5 pawn is a pawn, and the e8 king is a check, not a threat.
		const chess = loadPosition("r3k3/2N5/4b3/3p4/8/8/8/4K3 b - - 0 1");
		expect(chess).not.toBeNull();
		expect(chess && winnableTargets(chess, "c7", "w").sort()).toEqual(["a8", "e6"]);
	});

	it("answers nothing for an empty square or a square holding the other side's piece", () => {
		const chess = loadPosition("r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1");
		expect(chess && winnableTargets(chess, "d4", "w")).toEqual([]);
		expect(chess && winnableTargets(chess, "a8", "w")).toEqual([]);
	});
});

describe("boardEffectsFor", () => {
	it("answers nothing for an unreadable position or an illegal move", () => {
		expect(boardEffectsFor({ fen: "not a position", uci: "e2e4" })).toEqual([]);
		expect(boardEffectsFor({ fen: START, uci: "e2e5" })).toEqual([]);
		expect(boardEffectsFor({ fen: START, uci: "zz99" })).toEqual([]);
	});

	it("answers nothing for a quiet opening move", () => {
		expect(rays(START, "e2e4")).toEqual([]);
	});

	it("names the check from the piece that gives it", () => {
		expect(rays("4k3/8/8/8/8/8/8/4KR2 w - - 0 1", "f1f8")).toEqual(["check f8e8"]);
	});

	it("calls a check plus a threat from the same square a fork", () => {
		// Nb5–c7 forks the e8 king and the a8 rook.
		expect(rays("r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", "b5c7")).toEqual(["check c7e8", "fork c7a8"]);
	});

	it("calls two threats from one square a fork and a single threat a threat", () => {
		expect(rays("r3r3/8/8/1N6/8/8/8/1K4k1 w - - 0 1", "b5c7")).toEqual(["fork c7a8", "fork c7e8"]);
		expect(rays("r7/8/8/1N6/8/8/8/4K1k1 w - - 0 1", "b5c7")).toEqual(["threat c7a8"]);
	});

	it("draws a restraint chain through the piece in front to the piece behind", () => {
		// Ba4–b5 pins the c6 knight to the e8 king. The first leg is already the threat ray.
		expect(rays("4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1", "a4b5")).toEqual(["threat b5c6", "pin c6e8"]);
	});

	it("draws a discovered attack from the uncovering piece, not from the piece that moved", () => {
		// Nd3–f4 opens the d-file; the d1 rook now hits the d8 queen.
		expect(rays("3q4/8/8/8/8/3N4/8/3RK2k w - - 0 1", "d3f4")).toEqual(["discovery d1d8"]);
	});

	it("draws a discovered check from the checker", () => {
		expect(rays("3k4/8/8/3B4/8/8/8/3RK3 w - - 0 1", "d5c6")).toEqual(["discovery d1d8"]);
	});

	it("reports a capture as a ray from the origin onto the destination", () => {
		expect(rays("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "e4d5")).toEqual([
			"capture e4d5",
		]);
	});

	it("reports en passant as the capture plus a ray onto the pawn's real square", () => {
		expect(rays("8/8/8/3pP3/8/8/8/K6k w - d6 0 2", "e5d6")).toEqual(["capture e5d6", "passant d6d5"]);
	});

	it("traces both pieces of a castle", () => {
		const short = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
		expect(rays(short, "e1g1")).toEqual(["castle e1g1", "castle h1f1"]);
		expect(rays(short, "e1c1")).toEqual(["castle e1c1", "castle a1d1"]);
	});

	it("flourishes on the promotion square", () => {
		expect(rays("8/1P6/8/8/8/8/8/K6k w - - 0 1", "b7b8q")).toEqual(["promotion b8b8"]);
	});

	it("draws one ray per pair of squares and never more than the cap", () => {
		// A queen landing in the middle of a loose black army: every threat is its own ray, the
		// duplicates are folded away, and the batch stays inside `maxEffects`.
		const effects = boardEffectsFor({
			fen: "1r1r1r2/2r1r3/8/8/2r1r3/8/8/K5Qk w - - 0 1",
			uci: "g1d4",
		});
		expect(effects.length).toBeLessThanOrEqual(BOARD_EFFECT_LIMITS.maxEffects);
		const pairs = effects.map((e) => `${e.from}${e.to}`);
		expect(new Set(pairs).size).toBe(pairs.length);
		expect(effects.filter((e) => e.kind === "fork").length).toBeLessThanOrEqual(
			BOARD_EFFECT_LIMITS.maxThreats
		);
	});

	it("reads the opponent's move exactly as it reads ours", () => {
		// Black's ...Nc6–d4 hits nothing; ...Nc5–b3 hits the a1 rook with a cheaper piece.
		expect(rays("4k3/8/2n5/8/8/8/8/R3K2R b KQ - 0 1", "c6d4")).toEqual([]);
		expect(rays("4k3/8/8/2n5/8/8/8/R3K3 b Q - 0 1", "c5b3")).toEqual(["threat b3a1"]);
	});
});
