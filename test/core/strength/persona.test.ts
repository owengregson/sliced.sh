// test/core/strength/persona.test.ts
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { SELECTION_CONSTANTS } from "@core/strength/constants";
import { createFormLatent, FormLatent, formEloShift } from "@core/strength/persona";

describe("FormLatent (AR(1) form_t = 0.85·form_{t−1} + N(0, 0.25), clamped ±1)", () => {
	it("starts at 0 and is deterministic per seed", () => {
		const a = createFormLatent(createRng("form"));
		const b = createFormLatent(createRng("form"));
		expect(a.value).toBe(0);
		const seqA = Array.from({ length: 20 }, () => a.next());
		const seqB = Array.from({ length: 20 }, () => b.next());
		expect(seqA).toEqual(seqB);
		expect(new Set(seqA).size).toBeGreaterThan(10);
	});
	it("stays within ±1 and has the AR(1) stationary spread", () => {
		const f = new FormLatent(createRng(11));
		let sum = 0;
		let sq = 0;
		let lag1 = 0;
		let prev = 0;
		const n = 20_000;
		for (let i = 0; i < n; i++) {
			const v = f.next();
			expect(Math.abs(v)).toBeLessThanOrEqual(1);
			sum += v;
			sq += v * v;
			lag1 += v * prev;
			prev = v;
		}
		const mean = sum / n;
		const sd = Math.sqrt(sq / n - mean * mean);
		expect(Math.abs(mean)).toBeLessThan(0.05);
		// Unclamped stationary sd would be 0.25/√(1−0.85²) ≈ 0.475; clamping trims the tails.
		expect(sd).toBeGreaterThan(0.38);
		expect(sd).toBeLessThan(0.5);
		// Strong positive autocorrelation (≈ 0.85 before clamping).
		expect(lag1 / n / (sd * sd)).toBeGreaterThan(0.7);
	});
	it("next() applies exactly 0.85·prev + N(0, 0.25) using the rng", () => {
		const rng = createRng(5);
		const twin = createRng(5);
		const f = new FormLatent(rng, 0.5);
		const expected = Math.max(-1, Math.min(1, 0.85 * 0.5 + twin.normal(0, 0.25)));
		expect(f.next()).toBeCloseTo(expected, 12);
		expect(SELECTION_CONSTANTS.form.ar).toBe(0.85);
		expect(SELECTION_CONSTANTS.form.noiseSigma).toBe(0.25);
	});
	it("formEloShift is 150·form", () => {
		expect(formEloShift(1)).toBe(150);
		expect(formEloShift(-0.5)).toBe(-75);
	});
});
