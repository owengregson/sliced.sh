// test/core/chess/squares.test.ts
import { describe, expect, it } from "bun:test";
import { distance, fileOf, isSquare, rankOf, squareOf } from "@core/chess/squares";

describe("squares", () => {
	it("fileOf/rankOf are 0-based", () => {
		expect(fileOf("a1")).toBe(0);
		expect(rankOf("a1")).toBe(0);
		expect(fileOf("e4")).toBe(4);
		expect(rankOf("e4")).toBe(3);
		expect(fileOf("h8")).toBe(7);
		expect(rankOf("h8")).toBe(7);
	});
	it("squareOf inverts fileOf/rankOf and rejects out-of-range", () => {
		expect(squareOf(4, 3)).toBe("e4");
		expect(squareOf(0, 0)).toBe("a1");
		expect(squareOf(7, 7)).toBe("h8");
		expect(squareOf(8, 0)).toBeNull();
		expect(squareOf(0, -1)).toBeNull();
		expect(squareOf(1.5, 0)).toBeNull();
		for (const f of [0, 3, 7])
			for (const r of [0, 4, 7]) {
				const sq = squareOf(f, r);
				expect(sq && fileOf(sq)).toBe(f);
				expect(sq && rankOf(sq)).toBe(r);
			}
	});
	it("isSquare guards strings", () => {
		expect(isSquare("e4")).toBe(true);
		expect(isSquare("i4")).toBe(false);
		expect(isSquare("e9")).toBe(false);
		expect(isSquare("e")).toBe(false);
		expect(isSquare("E4")).toBe(false);
	});
	it("distance returns Chebyshev and Euclidean", () => {
		expect(distance("a1", "a1")).toEqual({ chebyshev: 0, euclidean: 0 });
		expect(distance("a1", "h8")).toEqual({ chebyshev: 7, euclidean: Math.sqrt(98) });
		expect(distance("e4", "e5")).toEqual({ chebyshev: 1, euclidean: 1 });
		expect(distance("b1", "c3")).toEqual({ chebyshev: 2, euclidean: Math.sqrt(5) });
		expect(distance("c3", "b1")).toEqual(distance("b1", "c3"));
	});
});
