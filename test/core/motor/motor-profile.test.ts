// test/core/motor/motor-profile.test.ts — Appendix G §8 modulation.
import { describe, expect, it } from "bun:test";
import { MOTOR_DEFAULTS, PREVIEW, PROMOTION_LOOK_DELAY_MS } from "@core/motor/constants";
import {
	chooseStyle,
	perGameProfile,
	perMoveProfile,
	profileFor,
	sampleRange,
} from "@core/motor/motor-profile";
import { createRng } from "@core/rng";

describe("profileFor", () => {
	it("blitz is faster and sloppier than rapid; classical slower with more hesitation", () => {
		const blitz = profileFor("balanced", "blitz", "normal");
		const rapid = profileFor("balanced", "rapid", "normal");
		const classical = profileFor("balanced", "classical", "normal");
		expect(rapid).toEqual({ ...MOTOR_DEFAULTS, exploration: rapid.exploration });
		expect(blitz.travelSpeedScale).toBeLessThan(rapid.travelSpeedScale);
		expect(blitz.fittsA).toBeLessThan(rapid.fittsA);
		expect(blitz.reactionMs[1]).toBeLessThan(rapid.reactionMs[1]);
		expect(blitz.overshootProb).toBeGreaterThan(rapid.overshootProb);
		expect(blitz.hesitationProb).toBeLessThan(rapid.hesitationProb);
		expect(classical.travelSpeedScale).toBeGreaterThan(rapid.travelSpeedScale);
		expect(classical.hesitationProb).toBeGreaterThan(rapid.hesitationProb);
	});
	it("premoves scale ×0.7, promotions add the look-delay, blitz captures ×0.8", () => {
		const normal = profileFor("balanced", "rapid", "normal");
		const premove = profileFor("balanced", "rapid", "premove");
		expect(premove.travelSpeedScale).toBeCloseTo(normal.travelSpeedScale * 0.7, 6);
		expect(premove.reactionMs[0]).toBeCloseTo(normal.reactionMs[0] * 0.7, 6);
		expect(normal.lookDelayMs).toEqual([0, 0]);
		expect(profileFor("balanced", "rapid", "promotion").lookDelayMs).toEqual(PROMOTION_LOOK_DELAY_MS);
		const cap = profileFor("balanced", "blitz", "capture");
		expect(cap.travelSpeedScale).toBeCloseTo(
			profileFor("balanced", "blitz", "normal").travelSpeedScale * 0.8,
			6
		);
		expect(profileFor("balanced", "rapid", "capture").travelSpeedScale).toBe(normal.travelSpeedScale);
	});
	it("sets the persona preview base and keeps persona modulation mild", () => {
		for (const persona of ["cautious", "balanced", "aggressive", "blitz"] as const) {
			const p = profileFor(persona, "rapid", "normal");
			expect(p.exploration.previewBase).toBe(PREVIEW.base[persona]);
			expect(p.fittsA / MOTOR_DEFAULTS.fittsA).toBeGreaterThan(0.8);
			expect(p.fittsA / MOTOR_DEFAULTS.fittsA).toBeLessThan(1.2);
		}
		expect(profileFor("cautious", "rapid", "normal").hesitationProb).toBeGreaterThan(
			profileFor("aggressive", "rapid", "normal").hesitationProb
		);
	});
	it("accepts a fitted base profile", () => {
		const base = { ...MOTOR_DEFAULTS, version: 7, jitterPx: 0.9 };
		expect(profileFor("balanced", "rapid", "normal", base).version).toBe(7);
		expect(profileFor("balanced", "rapid", "normal", base).jitterPx).toBeCloseTo(0.9, 6);
	});
});

describe("per-game and per-move noise", () => {
	it("perGameProfile offsets every parameter within ±10 % and picks a dominant style", () => {
		for (let seed = 0; seed < 50; seed++) {
			const g = perGameProfile(MOTOR_DEFAULTS, createRng(seed));
			const ratio = (a: number, b: number) => a / b;
			for (const k of [
				"fittsA",
				"fittsB",
				"travelSpeedScale",
				"jitterPx",
				"peakSpeedCapPxPerS",
			] as const) {
				expect(ratio(g[k], MOTOR_DEFAULTS[k])).toBeGreaterThanOrEqual(0.9 - 1e-9);
				expect(ratio(g[k], MOTOR_DEFAULTS[k])).toBeLessThanOrEqual(1.1 + 1e-9);
			}
			expect(g.reactionMs[0]).toBeLessThan(g.reactionMs[1]);
			expect(g.sampleIntervalMs).toBe(MOTOR_DEFAULTS.sampleIntervalMs);
			expect(g.styleMix.bezier + g.styleMix.wind).toBeCloseTo(1, 6);
			expect(g.styleMix.bezier === 0.85 || g.styleMix.wind === 0.7).toBe(true);
			expect(g.overshootProb).toBeLessThanOrEqual(1);
		}
	});
	it("perMoveProfile is lognormal noise clamped to ±25 % and never identical twice", () => {
		const rng = createRng("moves");
		const seen = new Set<string>();
		for (let i = 0; i < 300; i++) {
			const m = perMoveProfile(MOTOR_DEFAULTS, rng);
			for (const k of ["fittsA", "fittsB", "jitterPx", "travelSpeedScale", "overshootProb"] as const) {
				const r = m[k] / MOTOR_DEFAULTS[k];
				expect(r).toBeGreaterThanOrEqual(0.75 - 1e-9);
				expect(r).toBeLessThanOrEqual(1.25 + 1e-9);
			}
			expect(m.sampleIntervalMs).toBe(MOTOR_DEFAULTS.sampleIntervalMs);
			expect(m.version).toBe(MOTOR_DEFAULTS.version);
			seen.add(JSON.stringify(m));
		}
		expect(seen.size).toBe(300);
	});
	it("chooseStyle follows the mix and sampleRange stays in range", () => {
		const rng = createRng("style");
		let wind = 0;
		for (let i = 0; i < 2_000; i++)
			if (chooseStyle({ bezier: 0.3, wind: 0.7 }, rng) === "wind") wind++;
		expect(wind / 2_000).toBeGreaterThan(0.64);
		expect(wind / 2_000).toBeLessThan(0.76);
		for (let i = 0; i < 100; i++) {
			const v = sampleRange([40, 120], rng);
			expect(v).toBeGreaterThanOrEqual(40);
			expect(v).toBeLessThanOrEqual(120);
		}
	});
});
