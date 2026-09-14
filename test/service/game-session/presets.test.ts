// test/service/game-session/presets.test.ts — Task 30 checklist item 8 / Appendix F §4.6: the
// timing preset a detected time control selects, and what it means numerically. The Settings
// view's chips display exactly this, so the two can never drift apart.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { effectivePremoveTendency, SETTING_GAIN } from "@core/constants/setting-gain";
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
		// The user's 2× is re-based by `SETTING_GAIN.speedScale` for the detected class first (owner,
		// 2026-09-13), then the preset scales that: bullet 2 × 1 × 0.75, classical 2 × 1.3 × 1.35.
		const g = SETTING_GAIN.speedScale;
		const base = timing({ profile: "natural", speedScale: 2 });
		const bullet = timingSettingsFor(base, BULLET);
		expect(bullet.profile).toBe("fast");
		expect(bullet.speedScale).toBeCloseTo(2 * g.bullet * 0.75, 12);
		const blitz = timingSettingsFor(base, BLITZ);
		expect(blitz.profile).toBe("natural");
		expect(blitz.speedScale).toBeCloseTo(2 * g.blitz, 12);
		const rapid = timingSettingsFor(base, RAPID);
		expect(rapid.profile).toBe("natural");
		expect(rapid.speedScale).toBeCloseTo(2 * g.rapid, 12);
		const classical = timingSettingsFor(base, CLASSICAL);
		expect(classical.profile).toBe("slow");
		expect(classical.speedScale).toBeCloseTo(2 * g.classical * 1.35, 12);
		// The gain that differs by class is the point of the 2026-09-13 change: a 3+0 is not paced
		// like a 15+10.
		expect(g.blitz).toBeLessThan(g.classical);
	});

	it("manual and custom take no preset knob — only the internal gains", () => {
		for (const profile of ["manual", "custom"] as const) {
			const base = timing({ profile, speedScale: 1.4, varianceScale: 0.3 });
			for (const [tc, cls] of [
				[BULLET, "bullet"],
				[CLASSICAL, "classical"],
			] as const) {
				const out = timingSettingsFor(base, tc);
				expect(out).toEqual({
					...base,
					speedScale: 1.4 * SETTING_GAIN.speedScale[cls],
					longThinkFrequency: base.longThinkFrequency * SETTING_GAIN.longThinkFrequency,
					premoveTendency: effectivePremoveTendency(base.premoveTendency),
				});
			}
		}
	});

	it("every knob the model acts on is the user's number through its gain; the rest survive untouched", () => {
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
			speedScale: SETTING_GAIN.speedScale.bullet * TIMING_PROFILE_KNOBS.fast.speedScale,
			longThinkFrequency: 2 * SETTING_GAIN.longThinkFrequency,
			premoveTendency: effectivePremoveTendency(0.9),
		});
		// varianceScale has no gain
		expect(out.varianceScale).toBe(0.5);
	});

	it("the default install runs the instructed effective values (owner, 2026-09-13)", () => {
		// No time control yet: the base-speed gain takes the blitz value, because a live game whose
		// clock has not been read yet is far more likely to be blitz than classical and erring slow is
		// what loses games (`SETTING_GAIN.speedScale`).
		const unknown = timingSettingsFor(DEFAULT_SETTINGS.timing, undefined);
		expect(unknown.profile).toBe("natural");
		expect(unknown.speedScale).toBeCloseTo(SETTING_GAIN.speedScale.blitz, 12);
		expect(unknown.longThinkFrequency).toBeCloseTo(0.8, 12);
		expect(unknown.premoveTendency).toBeCloseTo(0.8, 12);
		expect(unknown.varianceScale).toBe(DEFAULT_SETTINGS.timing.varianceScale);
		// The instructed 1.3 is what a rapid game runs at; a 3+0 runs at 1.0.
		expect(timingSettingsFor(DEFAULT_SETTINGS.timing, RAPID).speedScale).toBeCloseTo(1.3, 12);
		expect(timingSettingsFor(DEFAULT_SETTINGS.timing, BLITZ).speedScale).toBeCloseTo(1, 12);
	});
});
