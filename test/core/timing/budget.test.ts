// test/core/timing/budget.test.ts — Step 2: Appendix D §3a.2 budget controller.
import { describe, expect, it } from "bun:test";
import {
	budgetController,
	expectedMovesRemaining,
	reserveSec,
	scheduleAlloc,
} from "@core/timing/budget";
import { computeFeatures } from "@core/timing/features";
import { samplePersona } from "@core/timing/persona-latents";
import { ctx } from "./helpers";

describe("rolling clock budget", () => {
	it("keeps a material-dependent horizon after move 100 instead of assuming the game ends", () => {
		expect(expectedMovesRemaining(14, 16, 0)).toBeGreaterThan(expectedMovesRemaining(2, 4, 0));
		for (const ply of [80, 160, 240, 400]) {
			expect(expectedMovesRemaining(2, 4, ply)).toBe(expectedMovesRemaining(2, 4, 80));
			expect(expectedMovesRemaining(2, 4, ply)).toBeGreaterThanOrEqual(24);
		}
	});
	it("retains a reserve at every rating and shrinks monotonically with the actual clock", () => {
		for (const targetElo of [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3800]) {
			const p = samplePersona("budget", "balanced", targetElo);
			expect(reserveSec(180, p.tau)).toBeGreaterThan(7);
			let previous = 0;
			for (const clock of [0, 1, 5, 20, 60, 120, 180]) {
				const f = computeFeatures(ctx({ targetElo, myClockMs: clock * 1000 }));
				const allocation = budgetController(f, p);
				expect(allocation).toBeGreaterThanOrEqual(previous);
				expect(allocation).toBeGreaterThanOrEqual(0.15);
				previous = allocation;
			}
		}
	});
	it("spends less than a full increment and does not multiply it by clock urgency", () => {
		const p = samplePersona("increment", "balanced", 2400);
		const base = computeFeatures(ctx({ myClockMs: 15_000, targetElo: 2400 }));
		for (const inc_s of [1, 2, 5, 10, 30]) {
			const added = budgetController({ ...base, inc_s }, p) - budgetController(base, p);
			expect(added).toBeGreaterThan(inc_s * 0.7);
			expect(added).toBeLessThan(inc_s);
		}
	});
	it("does not interpret an ambiguous consumed-clock ratio as permission to spend more", () => {
		const p = samplePersona("ratio", "balanced", 2400);
		const f = computeFeatures(ctx());
		expect(budgetController({ ...f, budget_used_ratio: 1 }, p)).toBe(
			budgetController({ ...f, budget_used_ratio: -1 }, p)
		);
	});
	it("untimed games use a virtual schedule without clock pressure", () => {
		const p = samplePersona("untimed", "balanced", 2400);
		const f = computeFeatures(ctx({ baseSec: 0, incSec: 0, myClockMs: 0 }));
		expect(budgetController(f, p)).toBe(scheduleAlloc(f));
	});
});
