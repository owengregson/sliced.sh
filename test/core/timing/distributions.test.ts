// test/core/timing/distributions.test.ts
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { beta, logNormal, pareto, sigmoid, truncNormal } from "@core/timing/distributions";
import { median } from "./helpers";

describe("distributions", () => {
	it("sigmoid", () => {
		expect(sigmoid(0)).toBe(0.5);
		expect(sigmoid(40)).toBeCloseTo(1, 10);
		expect(sigmoid(-40)).toBeCloseTo(0, 10);
	});
	it("logNormal has the requested median", () => {
		const rng = createRng(1);
		const xs = Array.from({ length: 20_000 }, () => logNormal(rng, 2.5, 0.5));
		expect(median(xs)).toBeGreaterThan(2.4);
		expect(median(xs)).toBeLessThan(2.6);
	});
	it("pareto is ≥ x_m with the right tail mass", () => {
		const rng = createRng(2);
		const xs = Array.from({ length: 20_000 }, () => pareto(rng, 1.6, 1));
		for (const x of xs) expect(x).toBeGreaterThanOrEqual(1);
		// P(X > 4) = 4^−1.6 ≈ 0.109
		const frac = xs.filter((x) => x > 4).length / xs.length;
		expect(frac).toBeGreaterThan(0.09);
		expect(frac).toBeLessThan(0.13);
	});
	it("truncNormal stays inside the bounds", () => {
		const rng = createRng(3);
		for (let i = 0; i < 5000; i++) {
			const x = truncNormal(rng, 0, 1, -0.5, 0.5);
			expect(x).toBeGreaterThanOrEqual(-0.5);
			expect(x).toBeLessThanOrEqual(0.5);
		}
	});
	it("beta(2,2) is symmetric in (0,1) and beta(9.6,5.2) has mean ≈ 0.65", () => {
		const rng = createRng(4);
		const sym = Array.from({ length: 20_000 }, () => beta(rng, 2, 2));
		for (const x of sym) {
			expect(x).toBeGreaterThan(0);
			expect(x).toBeLessThan(1);
		}
		const mean = sym.reduce((a, b) => a + b, 0) / sym.length;
		expect(mean).toBeGreaterThan(0.48);
		expect(mean).toBeLessThan(0.52);
		const skew = Array.from({ length: 20_000 }, () => beta(rng, 9.6, 5.2));
		const m2 = skew.reduce((a, b) => a + b, 0) / skew.length;
		expect(m2).toBeGreaterThan(0.63);
		expect(m2).toBeLessThan(0.67);
	});
});
