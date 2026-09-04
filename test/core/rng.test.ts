// test/core/rng.test.ts
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";

describe("createRng", () => {
	it("is deterministic per seed and differs across seeds", () => {
		const a0 = createRng(42);
		const a = Array.from({ length: 8 }, () => a0.next());
		const b = createRng(42);
		for (const v of a) expect(b.next()).toBe(v);
		const s1 = createRng("alpha");
		const s2 = createRng("alpha");
		const s3 = createRng("beta");
		const x = Array.from({ length: 8 }, () => s1.next());
		expect(Array.from({ length: 8 }, () => s2.next())).toEqual(x);
		expect(Array.from({ length: 8 }, () => s3.next())).not.toEqual(x);
		expect(createRng(1).next()).not.toBe(createRng(2).next());
	});
	it("next() stays in [0,1) and is roughly uniform", () => {
		const r = createRng(7);
		let sum = 0;
		let lo = Number.POSITIVE_INFINITY;
		let hi = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < 20_000; i++) {
			const v = r.next();
			sum += v;
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
		}
		expect(lo).toBeGreaterThanOrEqual(0);
		expect(hi).toBeLessThan(1);
		expect(Math.abs(sum / 20_000 - 0.5)).toBeLessThan(0.01);
	});
	it("int(min,max) is inclusive at both ends", () => {
		const r = createRng("ints");
		const seen = new Set<number>();
		let allValid = true;
		for (let i = 0; i < 2_000; i++) {
			const v = r.int(3, 6);
			allValid &&= Number.isInteger(v) && v >= 3 && v <= 6;
			seen.add(v);
		}
		expect(allValid).toBe(true);
		expect([...seen].sort()).toEqual([3, 4, 5, 6]);
		expect(r.int(5, 5)).toBe(5);
	});
	it("normal(mu,sigma) matches mean and sd over 20k samples", () => {
		const r = createRng("normal");
		const n = 20_000;
		let sum = 0;
		let sq = 0;
		for (let i = 0; i < n; i++) {
			const v = r.normal(10, 2);
			sum += v;
			sq += v * v;
		}
		const mean = sum / n;
		const sd = Math.sqrt(sq / n - mean * mean);
		expect(Math.abs(mean - 10)).toBeLessThan(0.05);
		expect(Math.abs(sd - 2)).toBeLessThan(0.05);
	});
	it("logNormal is positive with median exp(mu)", () => {
		const r = createRng("ln");
		const vals = Array.from({ length: 5_001 }, () => r.logNormal(1, 0.5)).sort((a, b) => a - b);
		expect(vals[0] ?? 0).toBeGreaterThan(0);
		const median = vals[2_500] ?? 0;
		expect(Math.abs(median - Math.E)).toBeLessThan(0.1);
	});
	it("weighted picks in proportion to weights", () => {
		const r = createRng("weights");
		const counts = { a: 0, b: 0, c: 0 };
		for (let i = 0; i < 10_000; i++) counts[r.weighted(["a", "b", "c"] as const, [1, 2, 7])]++;
		expect(Math.abs(counts.a / 10_000 - 0.1)).toBeLessThan(0.02);
		expect(Math.abs(counts.b / 10_000 - 0.2)).toBeLessThan(0.02);
		expect(Math.abs(counts.c / 10_000 - 0.7)).toBeLessThan(0.02);
		expect(() => r.weighted([1, 2], [1])).toThrow();
		expect(() => r.weighted([1, 2], [0, 0])).toThrow();
	});
	it("pick and chance behave", () => {
		const r = createRng(3);
		const items = ["x", "y", "z"];
		for (let i = 0; i < 100; i++) expect(items).toContain(r.pick(items));
		expect(() => r.pick([])).toThrow();
		let hits = 0;
		for (let i = 0; i < 10_000; i++) if (r.chance(0.3)) hits++;
		expect(Math.abs(hits / 10_000 - 0.3)).toBeLessThan(0.02);
		expect(r.chance(0)).toBe(false);
		expect(r.chance(1)).toBe(true);
	});
});
