import { describe, expect, it } from "bun:test";
import { hash32, mulberry32 } from "./random";

describe("random", () => {
	it("mulberry32 is a seeded stream in [0, 1)", () => {
		const a = mulberry32(7);
		const b = mulberry32(7);
		const xs = Array.from({ length: 5 }, () => a());
		expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
		for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
		expect(mulberry32(8)()).not.toBe(xs[0]);
	});

	it("hash32 is FNV-1a", () => {
		expect(hash32("")).toBe(0x811c9dc5);
		expect(hash32("a")).toBe(0xe40c292c);
	});
});
