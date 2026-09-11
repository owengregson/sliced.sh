// test/core/motor/path-generator.test.ts — Step 1 geometry tests (Appendix G §7.3).
import { describe, expect, it } from "bun:test";
import { MIN_JERK, MOTOR_DEFAULTS } from "@core/motor/constants";
import { generatePath, grabWobble, idleTremor } from "@core/motor/path-generator";
import type { MotorProfile, Rect } from "@core/motor/types";
import { createRng } from "@core/rng";
import { dist, inside, smooth, speeds, totalMs } from "./fixtures";

const FROM = { x: 100, y: 100 };
const TO = { x: 400, y: 300 };
const TARGET: Rect = { left: 360, top: 260, width: 80, height: 80 };
const BEZIER_ONLY: MotorProfile = { ...MOTOR_DEFAULTS, styleMix: { bezier: 1, wind: 0 } };

function fittsEstimate(m: MotorProfile): number {
	const d = dist(FROM, TO);
	const id = Math.log2(d / Math.min(TARGET.width, TARGET.height) + 1);
	return (m.fittsA + m.fittsB * id) * 1000 * m.travelSpeedScale;
}

describe("generatePath", () => {
	it("starts near the start, lands inside the target, integer coordinates, ≥ 20 points", () => {
		for (let seed = 0; seed < 25; seed++) {
			const path = generatePath(FROM, TO, TARGET, MOTOR_DEFAULTS, createRng(seed));
			expect(path.length).toBeGreaterThanOrEqual(20);
			const first = path[0]!;
			expect(dist(FROM, first)).toBeLessThanOrEqual(12);
			expect(inside(path[path.length - 1]!, TARGET, 2)).toBe(true);
			for (const p of path) {
				expect(Number.isInteger(p.x)).toBe(true);
				expect(Number.isInteger(p.y)).toBe(true);
				expect(p.dtMs).toBeGreaterThan(0);
			}
		}
	});

	it("total duration is within [0.6, 1.6]× the Fitts estimate", () => {
		const est = fittsEstimate(MOTOR_DEFAULTS);
		for (let seed = 0; seed < 50; seed++) {
			const path = generatePath(FROM, TO, TARGET, MOTOR_DEFAULTS, createRng(seed));
			const t = totalMs(path);
			expect(t).toBeGreaterThanOrEqual(0.6 * est);
			expect(t).toBeLessThanOrEqual(1.6 * est);
		}
	});

	it("has a minimum-jerk speed profile: one dominant mid-path peak, slow ends", () => {
		for (let seed = 100; seed < 120; seed++) {
			const path = generatePath(FROM, TO, TARGET, BEZIER_ONLY, createRng(seed));
			const v = smooth(speeds(FROM, path));
			let peak = 0;
			let at = 0;
			v.forEach((s, i) => {
				if (s > peak) {
					peak = s;
					at = i;
				}
			});
			const frac = at / v.length;
			expect(frac).toBeGreaterThanOrEqual(0.25);
			expect(frac).toBeLessThanOrEqual(0.75);
			const head = (v[0]! + v[1]! + v[2]!) / 3;
			const tail = (v[v.length - 1]! + v[v.length - 2]! + v[v.length - 3]!) / 3;
			expect(head).toBeLessThan(0.3 * peak);
			expect(tail).toBeLessThan(0.3 * peak);
			// The nominal peak never exceeds the profile cap.
			expect(peak * 1000).toBeLessThanOrEqual(BEZIER_ONLY.peakSpeedCapPxPerS);
			expect(peak * 1000).toBeGreaterThan(
				((0.5 * MIN_JERK.peakSpeedFactor * dist(FROM, TO)) / (1.6 * fittsEstimate(BEZIER_ONLY))) * 1000
			);
		}
	});

	it("is deterministic per seed and differs across seeds", () => {
		const a = generatePath(FROM, TO, TARGET, MOTOR_DEFAULTS, createRng("s1"));
		const b = generatePath(FROM, TO, TARGET, MOTOR_DEFAULTS, createRng("s1"));
		const c = generatePath(FROM, TO, TARGET, MOTOR_DEFAULTS, createRng("s2"));
		expect(a).toEqual(b);
		expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
	});

	it("returns an empty path when already at the target and clamps short hops", () => {
		expect(generatePath(TO, TO, TARGET, MOTOR_DEFAULTS, createRng(1))).toEqual([]);
		const short = generatePath({ x: 380, y: 280 }, TO, TARGET, MOTOR_DEFAULTS, createRng(2));
		expect(short.length).toBeGreaterThan(1);
		expect(inside(short[short.length - 1]!, TARGET, 2)).toBe(true);
	});

	it("uses the wind style too and still lands inside the target", () => {
		const windOnly: MotorProfile = { ...MOTOR_DEFAULTS, styleMix: { bezier: 0, wind: 1 } };
		for (let seed = 0; seed < 20; seed++) {
			const path = generatePath(FROM, TO, TARGET, windOnly, createRng(seed));
			expect(path.length).toBeGreaterThanOrEqual(20);
			expect(dist(FROM, path[0]!)).toBeLessThanOrEqual(12);
			expect(inside(path[path.length - 1]!, TARGET, 2)).toBe(true);
			let prev = FROM;
			for (const p of path) {
				expect((dist(prev, p) / p.dtMs) * 1000).toBeLessThanOrEqual(windOnly.peakSpeedCapPxPerS);
				prev = p;
			}
		}
	});
});

describe("grabWobble", () => {
	it("settles in one bounded direction, suppressing repeated coordinates and reversals", () => {
		for (let seed = 0; seed < 200; seed++) {
			const pts = grabWobble({ x: 200, y: 200 }, MOTOR_DEFAULTS, createRng(seed));
			expect(pts.length).toBeLessThanOrEqual(4);
			let previous = { x: 200, y: 200 };
			const last = pts.at(-1) ?? previous;
			for (const p of pts) {
				expect(Number.isInteger(p.x)).toBe(true);
				expect(Number.isInteger(p.y)).toBe(true);
				expect(dist(p, { x: 200, y: 200 })).toBeLessThanOrEqual(3);
				expect(dist(previous, p)).toBeGreaterThan(0);
				expect((p.x - previous.x) * (last.x - 200)).toBeGreaterThanOrEqual(0);
				expect((p.y - previous.y) * (last.y - 200)).toBeGreaterThanOrEqual(0);
				expect(p.dtMs).toBeGreaterThanOrEqual(8);
				previous = p;
			}
		}
	});
});

// Resting on a piece must not generate a constant stream of tiny movements.
describe("idleTremor", () => {
	it("keeps short rests still and makes at most one bounded adjustment during a long rest", () => {
		let still = 0;
		let adjusted = 0;
		for (let seed = 0; seed < 500; seed++) {
			expect(idleTremor(FROM, 800, MOTOR_DEFAULTS, createRng(seed))).toEqual([]);
			const path = idleTremor(FROM, 5000, MOTOR_DEFAULTS, createRng(seed));
			expect(path.length).toBeLessThanOrEqual(1);
			if (!path.length) still += 1;
			else adjusted += 1;
			for (const point of path) {
				expect(point.dtMs).toBeGreaterThanOrEqual(650);
				expect(point.dtMs).toBeLessThanOrEqual(5000);
				expect(dist(point, FROM)).toBeLessThanOrEqual(Math.SQRT2 * 3);
			}
		}
		expect(still).toBeGreaterThan(400);
		expect(adjusted).toBeGreaterThan(0);
	});
});
