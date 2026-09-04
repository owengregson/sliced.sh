// test/core/timing/persona-latents.test.ts — Appendix D §4 persona sampling.
import { describe, expect, it } from "bun:test";
import { samplePersona } from "@core/timing/persona-latents";

describe("samplePersona", () => {
	it("is a pure function of the per-game seed", () => {
		const a = samplePersona("game-1", "balanced", 1650);
		const b = samplePersona("game-1", "balanced", 1650);
		expect(a).toEqual(b);
		expect(samplePersona("game-2", "balanced", 1650)).not.toEqual(a);
	});
	it("keeps every latent inside its range", () => {
		for (let i = 0; i < 500; i++) {
			const p = samplePersona(`g${i}`, "aggressive", 800 + (i % 17) * 100);
			expect(p.iota).toBeGreaterThanOrEqual(0);
			expect(p.iota).toBeLessThanOrEqual(1);
			expect(p.tau).toBeGreaterThan(0);
			expect(p.tau).toBeLessThan(1);
			expect(p.rho_mirror).toBeGreaterThanOrEqual(0.05);
			expect(p.rho_mirror).toBeLessThanOrEqual(0.3);
			expect(p.motor_k).toBeGreaterThan(0.4);
		}
	});
	it("profile and Elo shift the means", () => {
		const n = 2000;
		const mean = (
			profile: "cautious" | "aggressive" | "blitz" | "balanced",
			elo: number,
			key: "s_game" | "pi_p" | "tau" | "iota"
		) => {
			let s = 0;
			for (let i = 0; i < n; i++) s += samplePersona(`s${i}`, profile, elo)[key];
			return s / n;
		};
		expect(mean("aggressive", 1650, "s_game")).toBeLessThan(mean("cautious", 1650, "s_game"));
		expect(mean("blitz", 1650, "pi_p")).toBeGreaterThan(mean("balanced", 1650, "pi_p") + 0.5);
		expect(mean("balanced", 2500, "tau")).toBeGreaterThan(mean("balanced", 800, "tau") + 0.2);
		expect(mean("balanced", 1650, "tau")).toBeGreaterThan(0.6);
		expect(mean("balanced", 1650, "tau")).toBeLessThan(0.7);
		expect(mean("blitz", 1650, "iota")).toBeGreaterThan(mean("balanced", 1650, "iota") + 0.1);
	});
});
