// test/content/adapters/geometry.test.ts
import { describe, expect, it } from "bun:test";
import {
	chesscomSquareToPoint,
	lichessSquareToPoint,
	pointToSquare,
	squareRect,
} from "@content/adapters/geometry";
import type { Square } from "@typedefs/game";
import { BOARD_RECT } from "./helpers";

const ALL_SQUARES: Square[] = [];
for (const f of "abcdefgh") for (const r of "12345678") ALL_SQUARES.push(`${f}${r}` as Square);

describe("chesscomSquareToPoint", () => {
	it("maps e2 on a white-bottom board and when flipped", () => {
		// square = 66 px; e = file 4 → x = 100 + 4*66 + 33 = 397; rank 2 → row 6 → y = 100 + 6*66 + 33 = 529
		expect(chesscomSquareToPoint("e2", BOARD_RECT, false)).toEqual({ x: 397, y: 529 });
		// flipped: x = 100 + (7-4)*66 + 33 = 331; y = 100 + 1*66 + 33 = 199
		expect(chesscomSquareToPoint("e2", BOARD_RECT, true)).toEqual({ x: 331, y: 199 });
		expect(chesscomSquareToPoint("a1", BOARD_RECT, false)).toEqual({ x: 133, y: 595 });
		expect(chesscomSquareToPoint("h8", BOARD_RECT, false)).toEqual({ x: 595, y: 133 });
	});
});

describe("lichessSquareToPoint", () => {
	it("matches chess.com's formula with asWhite = !flipped", () => {
		for (const sq of ALL_SQUARES) {
			expect(lichessSquareToPoint(sq, BOARD_RECT, true)).toEqual(
				chesscomSquareToPoint(sq, BOARD_RECT, false)
			);
			expect(lichessSquareToPoint(sq, BOARD_RECT, false)).toEqual(
				chesscomSquareToPoint(sq, BOARD_RECT, true)
			);
		}
	});
});

describe("pointToSquare", () => {
	it("round-trips every square in both orientations", () => {
		for (const flipped of [false, true]) {
			for (const sq of ALL_SQUARES) {
				const p = chesscomSquareToPoint(sq, BOARD_RECT, flipped);
				expect(pointToSquare(p, BOARD_RECT, flipped)).toBe(sq);
				const q = lichessSquareToPoint(sq, BOARD_RECT, !flipped);
				expect(pointToSquare(q, BOARD_RECT, flipped)).toBe(sq);
			}
		}
	});
	it("returns null outside the board", () => {
		expect(pointToSquare({ x: 10, y: 10 }, BOARD_RECT, false)).toBeNull();
		expect(pointToSquare({ x: 100 + 528, y: 200 }, BOARD_RECT, false)).toBeNull();
	});
});

describe("squareRect", () => {
	it("is the square's full box", () => {
		expect(squareRect("a8", BOARD_RECT, false)).toEqual({
			x: 100,
			y: 100,
			width: 66,
			height: 66,
			left: 100,
			top: 100,
			right: 166,
			bottom: 166,
		});
		expect(squareRect("a8", BOARD_RECT, true).x).toBe(100 + 7 * 66);
	});
});
