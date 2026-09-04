// test/core/chess/san.test.ts
import { describe, expect, it } from "bun:test";
import { applyMoves, legalMoves, parseUci, pvToSan, sanToUci, uciToSan } from "@core/chess/san";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** White pawn on e7 promotes without giving check (black king on a6). */
const PROMO = "8/4P3/k7/8/8/8/8/4K3 w - - 0 1";

describe("parseUci", () => {
	it("splits from/to/promotion", () => {
		expect(parseUci("e2e4")).toEqual({ from: "e2", to: "e4" });
		expect(parseUci("e7e8q")).toEqual({ from: "e7", to: "e8", promotion: "q" });
		expect(parseUci("e7e8k")).toBeNull();
		expect(parseUci("e9e8")).toBeNull();
		expect(parseUci("e2")).toBeNull();
		expect(parseUci("")).toBeNull();
	});
});

describe("uciToSan", () => {
	it("converts a pawn push", () => {
		expect(uciToSan(START, "e2e4")).toBe("e4");
	});
	it("converts a promotion", () => {
		expect(uciToSan(PROMO, "e7e8q")).toBe("e8=Q");
		expect(uciToSan(PROMO, "e7e8n")).toBe("e8=N");
	});
	it("returns null for illegal moves and bad input", () => {
		expect(uciToSan(START, "e2e5")).toBeNull();
		expect(uciToSan(START, "e7e5")).toBeNull();
		expect(uciToSan(START, "zz")).toBeNull();
		expect(uciToSan("bad fen", "e2e4")).toBeNull();
	});
});

describe("sanToUci", () => {
	it("round-trips with uciToSan", () => {
		expect(sanToUci(START, "e4")).toBe("e2e4");
		expect(sanToUci(START, "Nf3")).toBe("g1f3");
		expect(sanToUci(PROMO, "e8=Q")).toBe("e7e8q");
		const san = uciToSan(START, "g1f3");
		expect(san && sanToUci(START, san)).toBe("g1f3");
	});
	it("returns null for illegal SAN and bad input", () => {
		expect(sanToUci(START, "Nf6")).toBeNull();
		expect(sanToUci(START, "O-O")).toBeNull();
		expect(sanToUci("bad fen", "e4")).toBeNull();
	});
});

describe("pvToSan", () => {
	it("converts a 5-ply PV", () => {
		expect(pvToSan(START, ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"])).toEqual([
			"e4",
			"e5",
			"Nf3",
			"Nc6",
			"Bb5",
		]);
	});
	it("stops at the first illegal move and keeps the prefix", () => {
		expect(pvToSan(START, ["e2e4", "e7e5", "e4e5", "d7d6"])).toEqual(["e4", "e5"]);
		expect(pvToSan(START, ["e2e5"])).toEqual([]);
		expect(pvToSan(START, [])).toEqual([]);
		expect(pvToSan("bad fen", ["e2e4"])).toEqual([]);
	});
});

describe("applyMoves", () => {
	it("returns the resulting FEN", () => {
		expect(applyMoves(START, [])).toBe(START);
		expect(applyMoves(START, ["e2e4", "c7c5"])).toBe(
			"rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"
		);
	});
	it("round-trips through legalMoves and sanToUci", () => {
		const after = applyMoves(START, ["e2e4", "e7e5"]);
		expect(after).not.toBeNull();
		const uci = after && sanToUci(after, "Nf3");
		expect(uci).toBe("g1f3");
		expect(after && legalMoves(after)).toContain("g1f3");
	});
	it("returns null on an illegal move or bad FEN", () => {
		expect(applyMoves(START, ["e2e4", "e2e3"])).toBeNull();
		expect(applyMoves(START, ["e2e5"])).toBeNull();
		expect(applyMoves("bad fen", ["e2e4"])).toBeNull();
	});
});

describe("legalMoves", () => {
	it("lists 20 moves at the start position", () => {
		const moves = legalMoves(START);
		expect(moves.length).toBe(20);
		expect(moves).toContain("e2e4");
		expect(moves).toContain("g1f3");
	});
	it("includes promotion suffixes", () => {
		const moves = legalMoves(PROMO);
		expect(moves).toContain("e7e8q");
		expect(moves).toContain("e7e8n");
		expect(moves).toContain("e7e8r");
		expect(moves).toContain("e7e8b");
	});
	it("returns an empty list on a bad FEN", () => {
		expect(legalMoves("bad fen")).toEqual([]);
	});
});
