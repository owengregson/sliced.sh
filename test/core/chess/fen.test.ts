// test/core/chess/fen.test.ts
import { describe, expect, it } from "bun:test";
import { formatFen, isValidFen, parseFen, sideToMove } from "@core/chess/fen";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EP = "rnbqkbnr/pp2pppp/8/2ppP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
const CASTLING = "r3k2r/8/8/8/8/8/8/R3K2R b Kq - 5 30";

describe("parseFen / formatFen", () => {
	it("parses the start position", () => {
		const p = parseFen(START);
		expect(p).not.toBeNull();
		expect(p?.placement).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR");
		expect(p?.turn).toBe("w");
		expect(p?.castling).toBe("KQkq");
		expect(p?.enPassant).toBeNull();
		expect(p?.halfmove).toBe(0);
		expect(p?.fullmove).toBe(1);
	});
	it("round-trips the start position", () => {
		const p = parseFen(START);
		expect(p && formatFen(p)).toBe(START);
	});
	it("round-trips an en-passant square", () => {
		const p = parseFen(EP);
		expect(p?.enPassant).toBe("d6");
		expect(p && formatFen(p)).toBe(EP);
	});
	it("round-trips partial castling rights and counters", () => {
		const p = parseFen(CASTLING);
		expect(p?.turn).toBe("b");
		expect(p?.castling).toBe("Kq");
		expect(p?.halfmove).toBe(5);
		expect(p?.fullmove).toBe(30);
		expect(p && formatFen(p)).toBe(CASTLING);
	});
	it("returns null on malformed input", () => {
		expect(parseFen("")).toBeNull();
		expect(parseFen("nope")).toBeNull();
		expect(parseFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -")).toBeNull();
		expect(parseFen("rnbqkbnrr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBeNull();
		expect(parseFen("8/8/8/8/8/8/8/8 w - - 0 1")).toBeNull();
	});
});

describe("isValidFen", () => {
	it("accepts valid and rejects invalid FENs", () => {
		expect(isValidFen(START)).toBe(true);
		expect(isValidFen(EP)).toBe(true);
		expect(isValidFen("garbage")).toBe(false);
		expect(isValidFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1")).toBe(false);
	});
});

describe("sideToMove", () => {
	it("reads the active colour", () => {
		expect(sideToMove(START)).toBe("w");
		expect(sideToMove(CASTLING)).toBe("b");
		expect(sideToMove("bad fen")).toBeNull();
	});
});
