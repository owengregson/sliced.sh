// test/core/motor/windmouse.test.ts — Step 2 (Appendix G §2.3 port).
import { describe, expect, it } from "bun:test";
import { MOTOR_DEFAULTS, WIND } from "@core/motor/constants";
import { type WindMouseParams, windMousePath, windMouseSegment } from "@core/motor/windmouse";
import { createRng } from "@core/rng";
import { dist, totalMs } from "./fixtures";

const P: WindMouseParams = {
	gravity: 9,
	wind: 3,
	minWaitMs: 5,
	maxWaitMs: 12,
	maxStep: 12,
	targetArea: 12,
};

describe("windMousePath", () => {
	it("terminates within 1 px of the target in < 2000 iterations", () => {
		for (let seed = 0; seed < 30; seed++) {
			const path = windMousePath(50, 50, 700, 400, P, createRng(seed));
			expect(path.length).toBeGreaterThan(10);
			expect(path.length).toBeLessThan(WIND.maxIterations);
			const last = path[path.length - 1]!;
			expect(dist(last, { x: 700, y: 400 })).toBeLessThanOrEqual(1);
		}
	});

	it("never exceeds maxStep per tick and damps inside targetArea", () => {
		for (let seed = 0; seed < 30; seed++) {
			const path = windMousePath(50, 50, 700, 400, P, createRng(seed));
			let prev = { x: 50, y: 50 };
			const steps: number[] = [];
			for (const p of path) {
				const s = dist(prev, p);
				expect(s).toBeLessThanOrEqual(P.maxStep + 1.5);
				expect(p.dtMs).toBeGreaterThanOrEqual(P.minWaitMs);
				expect(p.dtMs).toBeLessThanOrEqual(P.maxWaitMs);
				expect(Number.isInteger(p.x)).toBe(true);
				steps.push(s);
				prev = p;
			}
			// Damped approach: the mean step over the last 4 points is below the mid-flight mean.
			const mid = steps.slice(Math.floor(steps.length * 0.3), Math.floor(steps.length * 0.6));
			const tail = steps.slice(-4);
			const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
			expect(mean(tail)).toBeLessThan(mean(mid));
		}
	});

	it("is seed-deterministic", () => {
		const a = windMousePath(0, 0, 300, 120, P, createRng("w"));
		const b = windMousePath(0, 0, 300, 120, P, createRng("w"));
		expect(a).toEqual(b);
	});
});

describe("windMouseSegment", () => {
	it("rescales to the requested duration and respects the speed cap", () => {
		for (let seed = 0; seed < 20; seed++) {
			const path = windMouseSegment(
				{ x: 100, y: 100 },
				{ x: 500, y: 350 },
				600,
				MOTOR_DEFAULTS,
				createRng(seed)
			);
			const t = totalMs(path);
			expect(t).toBeGreaterThanOrEqual(600 * 0.9);
			expect(t).toBeLessThanOrEqual(600 * 1.3);
			expect(path[path.length - 1]).toMatchObject({ x: 500, y: 350 });
			let prev = { x: 100, y: 100 };
			for (const p of path) {
				expect((dist(prev, p) / p.dtMs) * 1000).toBeLessThanOrEqual(MOTOR_DEFAULTS.peakSpeedCapPxPerS);
				expect(p.dtMs).toBeGreaterThanOrEqual(WIND.minDtMs);
				prev = p;
			}
		}
	});
});
