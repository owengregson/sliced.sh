// test/core/strength/elo-map.test.ts
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import {
	b0For,
	betaFor,
	effectiveElo,
	engineEloFor,
	gapFor,
	sigmaFor,
	tauFor,
} from "@core/strength/elo-map";

describe("engineEloFor", () => {
	it("clamps the target to the engine's UCI_Elo range", () => {
		expect(engineEloFor(800)).toBe(1320);
		expect(engineEloFor(3200)).toBe(3190);
		expect(engineEloFor(1500)).toBe(1500);
		expect(engineEloFor(LIMITS.engineEloMin)).toBe(LIMITS.engineEloMin);
	});
});

describe("effectiveElo", () => {
	it("adds 150 per unit of form and clamps to LIMITS", () => {
		expect(effectiveElo(1500, 0)).toBe(1500);
		expect(effectiveElo(1500, 1)).toBe(1650);
		expect(effectiveElo(1500, -0.5)).toBe(1425);
		expect(effectiveElo(3200, 1)).toBe(LIMITS.eloMax);
		expect(effectiveElo(400, -1)).toBe(LIMITS.eloMin);
	});
});

describe("E-band helpers (§7.2 / Appendix E §1.5)", () => {
	it("τ(E) follows the published schedule", () => {
		expect(tauFor(2500)).toBeCloseTo(0.02, 5);
		expect(tauFor(2100)).toBeCloseTo(0.035, 2);
		expect(tauFor(1800)).toBeCloseTo(0.067, 2);
		expect(tauFor(1500)).toBeCloseTo(0.117, 2);
		expect(tauFor(1200)).toBeCloseTo(0.183, 2);
		expect(tauFor(900)).toBeCloseTo(0.271, 2);
		expect(tauFor(400)).toBe(0.3);
		expect(tauFor(3200)).toBeCloseTo(0.02 + 0.28 * (700 / 1700) ** 2, 6);
	});
	it("σ(E) is 50 below 800, 8 at ≥ 2400", () => {
		expect(sigmaFor(800)).toBe(50);
		expect(sigmaFor(2400)).toBe(8);
		expect(sigmaFor(3000)).toBe(8);
		expect(sigmaFor(1600)).toBeCloseTo(8 + 42 * 0.5, 6);
	});
	it("G(E) is 60 at ≥ 2200, 280 at 1500, 500 at ≤ 800", () => {
		expect(gapFor(2200)).toBe(60);
		expect(gapFor(2800)).toBe(60);
		expect(gapFor(1500)).toBeCloseTo(280, 6);
		expect(gapFor(800)).toBe(500);
		expect(gapFor(400)).toBe(500);
	});
	it("β(E) bands", () => {
		expect(betaFor(1599)).toBe(0.6);
		expect(betaFor(1600)).toBe(0.4);
		expect(betaFor(2199)).toBe(0.4);
		expect(betaFor(2200)).toBe(0.2);
	});
	it("b0(E) hits the table knots, is flat outside and interpolates between", () => {
		expect(b0For(800)).toBe(0.075);
		expect(b0For(1000)).toBe(0.075);
		expect(b0For(1200)).toBe(0.055);
		expect(b0For(1400)).toBe(0.04);
		expect(b0For(1600)).toBe(0.028);
		expect(b0For(1800)).toBe(0.02);
		expect(b0For(2000)).toBe(0.013);
		expect(b0For(2200)).toBe(0.009);
		expect(b0For(2500)).toBe(0.005);
		expect(b0For(3200)).toBe(0.005);
		expect(b0For(1300)).toBeCloseTo(0.0475, 6);
	});
});
