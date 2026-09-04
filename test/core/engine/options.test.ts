// test/core/engine/options.test.ts
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import {
	clampEngineOptions,
	ENGINE_OPTION_DEFAULTS,
	formatSetOption,
	optionsForSettings,
} from "@core/engine/options";
import { DEFAULT_SETTINGS, type Settings } from "@typedefs/settings";

function settings(patch: Partial<Settings["engine"]>, targetElo = 1500): Settings {
	return {
		...DEFAULT_SETTINGS,
		strength: { ...DEFAULT_SETTINGS.strength, targetElo },
		engine: { ...DEFAULT_SETTINGS.engine, ...patch },
	};
}

describe("optionsForSettings", () => {
	it("maps the Task 13 reference settings", () => {
		expect(
			optionsForSettings(settings({ threads: "auto", hashMb: 32, multiPv: 6 }, 1500), {
				hardwareConcurrency: 8,
			})
		).toEqual({
			Threads: 4,
			Hash: 32,
			MultiPV: 6,
			UCI_LimitStrength: true,
			UCI_Elo: 1500,
			UCI_ShowWDL: true,
			Ponder: false,
		});
	});
	it("clamps UCI_Elo to the engine's range", () => {
		const env = { hardwareConcurrency: 8 };
		expect(optionsForSettings(settings({}, 800), env).UCI_Elo).toBe(LIMITS.engineEloMin);
		expect(optionsForSettings(settings({}, 3200), env).UCI_Elo).toBe(LIMITS.engineEloMax);
	});
	it("derives threads: auto → clamp(hc − 2, 1, 4); explicit → clamped to threadsMax", () => {
		expect(optionsForSettings(settings({}), { hardwareConcurrency: 2 }).Threads).toBe(1);
		expect(optionsForSettings(settings({}), { hardwareConcurrency: 5 }).Threads).toBe(3);
		expect(optionsForSettings(settings({}), { hardwareConcurrency: 32 }).Threads).toBe(4);
		expect(optionsForSettings(settings({ threads: 6 }), { hardwareConcurrency: 2 }).Threads).toBe(6);
		expect(optionsForSettings(settings({ threads: 99 }), { hardwareConcurrency: 2 }).Threads).toBe(
			LIMITS.threadsMax
		);
		expect(optionsForSettings(settings({ threads: 0 }), { hardwareConcurrency: 2 }).Threads).toBe(1);
	});
	it("clamps Hash and MultiPV (MultiPV at least 4)", () => {
		const env = { hardwareConcurrency: 8 };
		expect(optionsForSettings(settings({ hashMb: 1 }), env).Hash).toBe(LIMITS.hashMbMin);
		expect(optionsForSettings(settings({ hashMb: 4096 }), env).Hash).toBe(LIMITS.hashMbMax);
		expect(optionsForSettings(settings({ multiPv: 1 }), env).MultiPV).toBe(4);
		expect(optionsForSettings(settings({ multiPv: 50 }), env).MultiPV).toBe(LIMITS.multiPvMax);
	});
});

describe("clampEngineOptions", () => {
	it("clamps numeric options and leaves the rest alone", () => {
		expect(
			clampEngineOptions({
				Threads: 0,
				Hash: 9999,
				MultiPV: 0,
				UCI_Elo: 100,
				"Skill Level": 99,
				"Move Overhead": -5,
				Ponder: true,
			})
		).toEqual({
			Threads: 1,
			Hash: LIMITS.hashMbMax,
			MultiPV: LIMITS.multiPvMin,
			UCI_Elo: LIMITS.engineEloMin,
			"Skill Level": 20,
			"Move Overhead": 0,
			Ponder: true,
		});
		expect(clampEngineOptions({})).toEqual({});
	});
	it("defaults are within their clamps", () => {
		expect(clampEngineOptions(ENGINE_OPTION_DEFAULTS)).toEqual(ENGINE_OPTION_DEFAULTS);
	});
});

describe("formatSetOption", () => {
	it("encodes names with spaces and boolean values", () => {
		expect(formatSetOption("Skill Level", 5)).toBe("setoption name Skill Level value 5");
		expect(formatSetOption("UCI_LimitStrength", true)).toBe(
			"setoption name UCI_LimitStrength value true"
		);
		expect(formatSetOption("Ponder", false)).toBe("setoption name Ponder value false");
	});
});
