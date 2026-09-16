// test/core/engine/options-max-strength.test.ts — the engine's own options in max-strength mode
// (owner, 2026-09-15: "maximal performance"), keyed off the session's active target.
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAX_STRENGTH } from "@core/constants/max-strength";
import { autoThreads, maxStrengthThreads, optionsForSettings } from "@core/engine/options";
import { DEFAULT_SETTINGS, type Settings } from "@typedefs/settings";

function settings(targetElo: number, engine: Partial<Settings["engine"]> = {}): Settings {
	return {
		...DEFAULT_SETTINGS,
		strength: { ...DEFAULT_SETTINGS.strength, targetElo },
		engine: { ...DEFAULT_SETTINGS.engine, ...engine },
	};
}

const env = (hardwareConcurrency: number, sab = true) => ({ hardwareConcurrency, sab });
const MAX = LIMITS.eloMax;

describe("optionsForSettings at max strength", () => {
	it("takes every core for `auto` threads up to the registry ceiling, and the largest hash", () => {
		for (const cores of [1, 4, 8, 16, 64]) {
			const options = optionsForSettings(settings(MAX), env(cores), MAX);
			expect(options.Threads).toBe(Math.min(cores, LIMITS.threadsMax));
			expect(options.Hash).toBe(MAX_STRENGTH.hashMb);
			expect(options.UCI_LimitStrength).toBe(false);
		}
		expect(maxStrengthThreads(Number.NaN)).toBe(1);
	});

	it("keeps an explicit thread count, a larger stored hash, and the single-threaded build", () => {
		expect(optionsForSettings(settings(MAX, { threads: 2 }), env(16), MAX).Threads).toBe(2);
		expect(optionsForSettings(settings(MAX, { hashMb: LIMITS.hashMbMax }), env(8), MAX).Hash).toBe(
			LIMITS.hashMbMax
		);
		expect(optionsForSettings(settings(MAX), env(16, false), MAX).Threads).toBe(1);
	});

	it("is decided by the active target alone, and only for the mode's own options", () => {
		const matched = optionsForSettings(settings(1500), env(8), MAX);
		expect(matched.Hash).toBe(MAX_STRENGTH.hashMb);
		// The limiter options still come from the stored settings, exactly as before.
		expect(matched.UCI_LimitStrength).toBe(true);
		expect(matched.UCI_Elo).toBe(1500);
		// The slider at 100 % with no active target yet, or a matched target below it: stored options.
		for (const active of [undefined, MAX - 1]) {
			const options = optionsForSettings(settings(MAX), env(8), active);
			expect(options.Hash).toBe(DEFAULT_SETTINGS.engine.hashMb);
			expect(options.Threads).toBe(autoThreads(8));
		}
	});

	it("maps every target below the ceiling exactly as the stored settings do", () => {
		for (const cores of [2, 8, 16])
			for (const target of [LIMITS.eloMin, 1500, 3190, 3201, MAX - 1]) {
				const s = settings(target, { hashMb: 32 });
				const options = optionsForSettings(s, env(cores));
				expect(optionsForSettings(s, env(cores), target)).toEqual(options);
				expect(optionsForSettings(settings(1500, { hashMb: 32 }), env(cores), target)).toEqual(
					optionsForSettings(settings(1500, { hashMb: 32 }), env(cores))
				);
				expect(options.Hash).toBe(32);
				expect(options.Threads).toBe(autoThreads(cores));
			}
	});
});
