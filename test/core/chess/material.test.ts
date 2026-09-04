// test/core/chess/material.test.ts
import { describe, expect, it } from "bun:test";
import { material, nonPawnMaterial } from "@core/chess/material";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("material", () => {
	it("counts the start position", () => {
		expect(material(START)).toEqual({ w: 39, b: 39, diff: 0 });
	});
	it("reports an imbalance from white's perspective", () => {
		// White is up a knight (black's b8 knight is gone).
		expect(material("r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toEqual({
			w: 39,
			b: 36,
			diff: 3,
		});
		// Black is up a rook.
		expect(material("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w Kkq - 0 1")).toEqual({
			w: 34,
			b: 39,
			diff: -5,
		});
	});
	it("ignores kings and returns null on a bad FEN", () => {
		expect(material("4k3/8/8/8/8/8/8/4K3 w - - 0 1")).toEqual({ w: 0, b: 0, diff: 0 });
		expect(material("bad fen")).toBeNull();
	});
});

describe("nonPawnMaterial", () => {
	it("sums both sides' minor/major pieces", () => {
		expect(nonPawnMaterial(START)).toBe(62);
		expect(nonPawnMaterial("8/5pk1/6p1/8/8/6P1/5PK1/4R3 w - - 0 40")).toBe(5);
		expect(nonPawnMaterial("bad fen")).toBeNull();
	});
});
