// test/service/game-session/presets.test.ts — the knobs the timing model actually runs with.
//
// 2026-09-15: the timing presets were removed at the owner's request ("remove the timing presets
// 'fast natural slow' etc."). The assertions that pinned `PROFILE_FOR_TC_CLASS`,
// `TIMING_PROFILE_KNOBS`, `effectiveTimingProfile` and `autoPlayAllowed` — the detected-preset
// table, the preset knob, and `manual` never auto-playing — described a feature that no longer
// exists and were deleted with it, not weakened. What remains is everything that still decides a
// move's pace: the per-time-control gain, the user's base speed, and the knobs that carry their
// own gains. The block below also pins that no preset factor survives anywhere in the product.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { SETTINGS_RANGES } from "@core/constants/limits";
import { effectivePremoveTendency, SETTING_GAIN } from "@core/constants/setting-gain";
import { timingSettingsFor } from "@service/game-session/presets";
import type { TimeControl } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";

const S = 1000;
const M = 60 * S;

/** One time control per `tcClass` band (Lichess's `base + 40 × inc`, seconds). */
const BULLET: TimeControl = { baseMs: 60 * S, incMs: 0 }; // 60 s → bullet
const BLITZ: TimeControl = { baseMs: 3 * M, incMs: 0 }; // 180 s → blitz
const RAPID: TimeControl = { baseMs: 10 * M, incMs: 0 }; // 600 s → rapid
const CLASSICAL: TimeControl = { baseMs: 30 * M, incMs: 0 }; // 1800 s → classical

const timing = (patch: Partial<Settings["timing"]> = {}): Settings["timing"] => ({
	...DEFAULT_SETTINGS.timing,
	...patch,
});

describe("the timing knobs a game runs with", () => {
	it("the per-time-control gain is the only class-dependent factor left", () => {
		const g = SETTING_GAIN.moveTimeScale;
		// At the default base speed (1) the gain stands alone: no preset multiplies it any more.
		// The numbers a preset used to contribute — bullet ×0.75, classical ×1.35 — are gone, so
		// these products are the gains themselves.
		for (const [tc, cls] of [
			[BULLET, "bullet"],
			[BLITZ, "blitz"],
			[RAPID, "rapid"],
			[CLASSICAL, "classical"],
		] as const)
			expect(timingSettingsFor(timing(), tc).moveTimeScale).toBeCloseTo(g[cls], 12);
		// The gain that differs by class is the point of the 2026-09-13 change: a 3+0 is not paced
		// like a 15+10.
		expect(g.blitz).toBeLessThan(g.classical);
	});

	it("no preset factor survives: bullet is not 0.75× and classical is not 1.35×", () => {
		const g = SETTING_GAIN.moveTimeScale;
		const base = timing({ baseSpeed: 0.5 });
		// A user at half speed takes twice as long, re-based by the class gain — and by nothing
		// else. The pre-2026-09-15 products were 2 × g.bullet × 0.75 and 2 × g.classical × 1.35.
		expect(timingSettingsFor(base, BULLET).moveTimeScale).toBeCloseTo(2 * g.bullet, 12);
		expect(timingSettingsFor(base, CLASSICAL).moveTimeScale).toBeCloseTo(2 * g.classical, 12);
		// The model's knobs no longer carry a profile at all.
		const out = timingSettingsFor(DEFAULT_SETTINGS.timing, BLITZ);
		expect(Object.keys(out).sort()).toEqual([
			"longThinkFrequency",
			"moveTimeScale",
			"premoveTendency",
			"respectBudget",
			"varianceScale",
		]);
		expect("profile" in out).toBe(false);
	});

	it("a `profile` left in storage by an older build cannot change the pace", () => {
		// The leaf is gone from `Settings`, so a stored one can only ever arrive as an extra key
		// on the object the normaliser rebuilt (which drops it) or on a hand-written patch.
		const legacy = { ...DEFAULT_SETTINGS.timing, profile: "fast" } as Settings["timing"];
		for (const tc of [BULLET, BLITZ, RAPID, CLASSICAL, undefined])
			expect(timingSettingsFor(legacy, tc)).toEqual(timingSettingsFor(DEFAULT_SETTINGS.timing, tc));
	});

	// ── base speed, 2026-09-15: higher must mean faster, and it is inverted exactly here ──────
	it("higher base speed is a shorter move, and this is the only place the inversion happens", () => {
		const at = (baseSpeed: number) => timingSettingsFor(timing({ baseSpeed }), BLITZ).moveTimeScale;
		// The owner's complaint in one line: the number the user raises must shorten the move.
		expect(at(2)).toBeLessThan(at(1));
		expect(at(1)).toBeLessThan(at(0.5));
		// Exactly reciprocal, with the per-class gain (blitz 1.0) and nothing else beside it.
		for (const baseSpeed of [0.35, 0.5, 1, 2, 4])
			expect(at(baseSpeed)).toBeCloseTo(SETTING_GAIN.moveTimeScale.blitz / baseSpeed, 12);
		// A stored value outside the slider cannot escape the range, and a non-number is ignored.
		const { min, max } = SETTINGS_RANGES.baseSpeed;
		expect(at(99)).toBeCloseTo(at(max), 12);
		expect(at(0)).toBeCloseTo(at(min), 12);
		expect(at(Number.NaN)).toBeCloseTo(at(1), 12);
	});

	it("every knob the model acts on is the user's number through its gain; the rest survive untouched", () => {
		const base = timing({
			baseSpeed: 1,
			varianceScale: 0.5,
			premoveTendency: 0.9,
			longThinkFrequency: 2,
			respectBudget: false,
		});
		const out = timingSettingsFor(base, BULLET);
		expect(out).toEqual({
			respectBudget: false,
			varianceScale: 0.5,
			moveTimeScale: SETTING_GAIN.moveTimeScale.bullet,
			longThinkFrequency: 2 * SETTING_GAIN.longThinkFrequency,
			premoveTendency: effectivePremoveTendency(0.9),
		});
		// varianceScale has no gain
		expect(out.varianceScale).toBe(0.5);
	});

	it("the default install runs the instructed effective values (owner, 2026-09-13)", () => {
		// No time control yet: the per-class gain takes the blitz value, because a live game whose
		// clock has not been read yet is far more likely to be blitz than classical and erring slow is
		// what loses games (`SETTING_GAIN.moveTimeScale`).
		const unknown = timingSettingsFor(DEFAULT_SETTINGS.timing, undefined);
		expect(unknown.moveTimeScale).toBeCloseTo(SETTING_GAIN.moveTimeScale.blitz, 12);
		expect(unknown.longThinkFrequency).toBeCloseTo(0.8, 12);
		expect(unknown.premoveTendency).toBeCloseTo(0.8, 12);
		expect(unknown.varianceScale).toBe(DEFAULT_SETTINGS.timing.varianceScale);
		// The instructed 1.3 is what a rapid game runs at; a 3+0 runs at 1.0. Unchanged by the
		// 2026-09-15 rework: the default `baseSpeed` is 1, so the gains stand alone.
		expect(timingSettingsFor(DEFAULT_SETTINGS.timing, RAPID).moveTimeScale).toBeCloseTo(1.3, 12);
		expect(timingSettingsFor(DEFAULT_SETTINGS.timing, BLITZ).moveTimeScale).toBeCloseTo(1, 12);
	});
});
