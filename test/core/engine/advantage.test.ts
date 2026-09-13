// test/core/engine/advantage.test.ts — the practical advantage index behind the second rail.
import { describe, expect, it } from "bun:test";
import { CHESS_START_FEN } from "@core/constants/chess";
import { advantageIndex, advantageShare } from "@core/engine/advantage";

const PAWN_UP = "rnbqkbnr/ppp1pppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2";
const ROOK_DOWN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w Kkq - 0 1";

describe("advantageIndex", () => {
	it("is level from the start position with no evaluation and no clocks", () => {
		expect(advantageIndex({ fen: CHESS_START_FEN, score: null })).toBe(0);
		expect(advantageShare(0)).toBe(0.5);
	});
	it("leans toward the side with more material, and more so for more material", () => {
		const pawn = advantageIndex({ fen: PAWN_UP, score: null }) ?? 0;
		const rook = advantageIndex({ fen: ROOK_DOWN, score: null }) ?? 0;
		expect(pawn).toBeGreaterThan(0);
		expect(rook).toBeLessThan(0);
		expect(Math.abs(rook)).toBeGreaterThan(Math.abs(pawn));
	});
	it("folds the engine score in gently rather than pinning the bar, and pins on a mate", () => {
		const level = advantageIndex({ fen: CHESS_START_FEN, score: { cp: 100 } }) ?? 0;
		expect(level).toBeGreaterThan(0);
		expect(level).toBeLessThan(0.15);
		expect(advantageIndex({ fen: CHESS_START_FEN, score: { cp: -800 } })).toBeLessThan(-0.3);
		expect(advantageIndex({ fen: CHESS_START_FEN, score: { mate: 3 } })).toBe(1);
		expect(advantageIndex({ fen: CHESS_START_FEN, score: { mate: -1 } })).toBe(-1);
	});
	it("counts the clocks only once someone is short of time", () => {
		const plenty = advantageIndex({
			fen: CHESS_START_FEN,
			score: null,
			clocks: { w: 300_000, b: 150_000 },
		});
		const scramble = advantageIndex({
			fen: CHESS_START_FEN,
			score: null,
			clocks: { w: 20_000, b: 5_000 },
		});
		expect(plenty).toBe(0);
		expect(scramble ?? 0).toBeGreaterThan(0.05);
		expect(advantageShare(scramble ?? 0)).toBeGreaterThan(0.5);
	});
	it("answers nothing for an unreadable position without a score", () => {
		expect(advantageIndex({ fen: "not a fen", score: null })).toBeNull();
	});
});
