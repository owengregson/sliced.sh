import { describe, expect, it } from "bun:test";
import { legalMoves } from "@core/chess/san";
import { CHESS_START_FEN, LEGAL_MOVES_CACHE_SIZE } from "@core/constants/chess";

describe("legalMoves' position cache", () => {
	it("returns a fresh array each time, so a caller's mutation cannot poison the cache", () => {
		const a = legalMoves(CHESS_START_FEN);
		a.length = 0;
		const b = legalMoves(CHESS_START_FEN);
		expect(b).toHaveLength(20);
		expect(b).not.toBe(legalMoves(CHESS_START_FEN));
	});
	it("answers correctly after the oldest positions are evicted", () => {
		const fens = Array.from(
			{ length: LEGAL_MOVES_CACHE_SIZE + 5 },
			(_, i) =>
				`4k3/8/8/8/8/8/${"P"
					.padStart((i % 8) + 1, "1")
					.padEnd(8, "1")
					.replace(/1+/g, (m) => String(m.length))}/4K3 w - - 0 ${i + 1}`
		);
		const first = legalMoves(fens[0] as string);
		for (const f of fens) legalMoves(f);
		expect(legalMoves(fens[0] as string)).toEqual(first);
		expect(legalMoves("not a fen")).toEqual([]);
	});
});
