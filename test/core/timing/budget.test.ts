// test/core/timing/budget.test.ts — Step 2: Appendix D §3a.2 budget controller.
import { describe, expect, it } from "bun:test";
import {
	budgetController,
	expectedMovesRemaining,
	reserveSec,
	scheduleAlloc,
} from "@core/timing/budget";
import { computeFeatures } from "@core/timing/features";
import type { Persona } from "@core/timing/types";
import { ctx, START_FEN } from "./helpers";

const persona = (tau: number): Persona => ({
	s_game: 0,
	iota: 0.5,
	pi_p: 0,
	tau,
	rho_mirror: 0.15,
	motor_k: 1,
});

describe("budget controller", () => {
	it("N_rem ≈ 42.6 at ply 0 and shrinks with material and ply", () => {
		expect(expectedMovesRemaining(14, 16, 0)).toBeCloseTo(42.6, 5);
		expect(expectedMovesRemaining(10, 12, 40)).toBeCloseTo(32, 5);
		expect(expectedMovesRemaining(4, 8, 80)).toBeCloseTo(19.6, 5);
		expect(expectedMovesRemaining(0, 0, 400)).toBe(10);
		expect(expectedMovesRemaining(30, 30, 0)).toBe(45);
	});
	it("3+0 at ply 0 allocates ≈ 4.0 s with τ = 0.65", () => {
		const f = computeFeatures(
			ctx({ fen: START_FEN, ply: 0, myClockMs: 180_000, oppClockMs: 180_000 })
		);
		expect(reserveSec(180, 0.65)).toBeCloseTo(0.65 * 10.8, 10);
		const alloc = budgetController(f, persona(0.65));
		// (180 − 7.02) / 42.6 · overspend(1 + 0.35·0.35) · exp(0.1·ratio) with ratio = 0 at ply 0.
		const raw = (180 - 0.65 * 10.8) / 42.6;
		expect(alloc).toBeCloseTo(raw * (1 + 0.35 * (1 - 0.65)), 6);
		expect(alloc).toBeGreaterThan(3.9);
		expect(alloc).toBeLessThan(4.7);
	});
	it("alloc never drops below 0.15 s", () => {
		for (const clock of [0, 500, 1_000, 3_000]) {
			const f = computeFeatures(ctx({ myClockMs: clock, oppClockMs: 100_000, ply: 70 }));
			expect(budgetController(f, persona(0.65))).toBeGreaterThanOrEqual(0.15);
		}
		// τ = 1 at ply ≥ 60: no overspend; the raw term is negative, so only the floor and the
		// schedule term remain.
		const f = computeFeatures(ctx({ myClockMs: 1_000, oppClockMs: 100_000, ply: 70 }));
		expect(budgetController(f, persona(1))).toBeCloseTo(
			Math.max(0.15, 0.15 * Math.exp(0.1 * f.budget_used_ratio)),
			10
		);
	});
	it("increment games add 0.9·inc", () => {
		const base = computeFeatures(ctx({ fen: START_FEN, ply: 0, baseSec: 180, incSec: 0 }));
		const inc = computeFeatures(ctx({ fen: START_FEN, ply: 0, baseSec: 180, incSec: 2 }));
		const a0 = budgetController(base, persona(1));
		const a2 = budgetController(inc, persona(1));
		// τ = 1 → no overspend; budget_used_ratio differs slightly through base_eff, so compare the raw term.
		const rawDiff =
			a2 / Math.exp(0.1 * inc.budget_used_ratio) - a0 / Math.exp(0.1 * base.budget_used_ratio);
		expect(rawDiff).toBeCloseTo(0.9 * 2, 6);
	});
	it("poor budgeters overspend early, not late", () => {
		const early = computeFeatures(ctx({ fen: START_FEN, ply: 0 }));
		const late = computeFeatures(ctx({ ply: 70 }));
		const ratioEarly = budgetController(early, persona(0.2)) / budgetController(early, persona(1));
		const ratioLate = budgetController(late, persona(0.2)) / budgetController(late, persona(1));
		expect(ratioEarly).toBeGreaterThan(ratioLate);
	});
	it("untimed games bypass the clock budget (classical schedule)", () => {
		const f = computeFeatures(ctx({ baseSec: 0, incSec: 0, myClockMs: 0, oppClockMs: 0 }));
		expect(budgetController(f, persona(0.2))).toBe(scheduleAlloc(f));
		expect(scheduleAlloc(f)).toBeCloseTo(1800 / 40, 10);
	});
});
