// test/service/game-session/presets.test.ts — Task 30 checklist item 8 / Appendix F §4.6: the
// timing preset a detected time control selects, and what it means numerically. The Settings
// view's chips display exactly this, so the two can never drift apart.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { PROFILE_FOR_TC_CLASS, TIMING_PROFILE_KNOBS } from "@core/constants/timings";
import { PROFILE_FOR_TC_CLASS as PANEL_PROFILE_FOR_TC_CLASS } from "@panel/views/settings/rows";
import {
	autoPlayAllowed,
	effectiveTimingProfile,
	timingSettingsFor,
} from "@service/game-session/presets";
import type { TimeControl } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";

const S = 1000;
const M = 60 * S;

/** One time control per `tcClass` band (Lichess's `base + 40 × inc`, seconds). */

const BULLET: TimeControl = { baseMs: 60 * S, incMs: 0 }; // 60 s → bullet
const BLITZ: TimeControl = { baseMs: 3 * M, incMs: 0 }; // 180 s → blitz
const RAPID: TimeControl = { baseMs: 10 * M, incMs: 0 }; // 600 s → rapid
const CLASSICAL: TimeControl = { baseMs: 30 * M, incMs: 0 }; // 1800 s → classical
const UNTIMED: TimeControl = { baseMs: 0, incMs: 0 };

const timing = (patch: Partial<Settings["timing"]> = {}): Settings["timing"] => ({
	...DEFAULT_SETTINGS.timing,
	...patch,
});

describe("timing presets (§4.6)", () => {
	it("the panel's chips and the session read one table", () => {
		expect(PANEL_PROFILE_FOR_TC_CLASS).toBe(PROFILE_FOR_TC_CLASS);
		expect(PROFILE_FOR_TC_CLASS).toEqual({
			bullet: "fast",
			blitz: "natural",
			rapid: "natural",
			classical: "slow",
		});
	});

	it("a detected class selects its preset over a stored preset", () => {
		for (const stored of ["fast", "natural", "slow"] as const) {
			expect(effectiveTimingProfile(stored, BULLET)).toBe("fast");
			expect(effectiveTimingProfile(stored, BLITZ)).toBe("natural");
			expect(effectiveTimingProfile(stored, RAPID)).toBe("natural");
			expect(effectiveTimingProfile(stored, CLASSICAL)).toBe("slow");
		}
	});

	it("manual and custom are the user's own choice and are never overridden", () => {
		for (const tc of [BULLET, BLITZ, RAPID, CLASSICAL, UNTIMED, undefined]) {
			expect(effectiveTimingProfile("manual", tc)).toBe("manual");
			expect(effectiveTimingProfile("custom", tc)).toBe("custom");
		}
	});

	it("an untimed game, or one whose time control is not known yet, keeps the stored profile", () => {
		expect(effectiveTimingProfile("slow", UNTIMED)).toBe("slow");
		expect(effectiveTimingProfile("slow", undefined)).toBe("slow");
		expect(effectiveTimingProfile("fast", UNTIMED)).toBe("fast");
	});

	it("manual never auto-plays; every other profile does", () => {
		expect(autoPlayAllowed("manual")).toBe(false);
		for (const p of ["fast", "natural", "slow", "custom"] as const)
			expect(autoPlayAllowed(p)).toBe(true);
	});

	it("the preset scales the user's speed slider (natural is the identity)", () => {
		// The two multipliers are log-symmetric about `natural` on the slider's own 0.05 grid.
		expect(TIMING_PROFILE_KNOBS).toEqual({
			fast: { speedScale: 0.75 },
			natural: { speedScale: 1 },
			slow: { speedScale: 1.35 },
		});
		const base = timing({ profile: "natural", speedScale: 2 });
		expect(timingSettingsFor(base, BULLET)).toMatchObject({ profile: "fast", speedScale: 1.5 });
		expect(timingSettingsFor(base, BLITZ)).toMatchObject({ profile: "natural", speedScale: 2 });
		expect(timingSettingsFor(base, RAPID)).toMatchObject({ profile: "natural", speedScale: 2 });
		expect(timingSettingsFor(base, CLASSICAL)).toMatchObject({ profile: "slow", speedScale: 2.7 });
	});

	it("manual and custom pass the sliders through untouched", () => {
		for (const profile of ["manual", "custom"] as const) {
			const base = timing({ profile, speedScale: 1.4, varianceScale: 0.3 });
			expect(timingSettingsFor(base, BULLET)).toEqual(base);
			expect(timingSettingsFor(base, CLASSICAL)).toEqual(base);
		}
	});

	it("every other knob survives the preset", () => {
		const base = timing({
			profile: "natural",
			speedScale: 1,
			varianceScale: 0.5,
			premoveTendency: 0.9,
			longThinkFrequency: 2,
			respectBudget: false,
		});
		const out = timingSettingsFor(base, BULLET);
		expect(out).toEqual({
			...base,
			profile: "fast",
			speedScale: TIMING_PROFILE_KNOBS.fast.speedScale,
		});
	});
});
