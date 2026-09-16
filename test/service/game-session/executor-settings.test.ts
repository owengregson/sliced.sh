// test/service/game-session/executor-settings.test.ts — the hand's controls as the executor runs
// them: the two hand sliders through `SETTING_GAIN` (owner, 2026-09-13), previews off → 0, and
// since 2026-09-15 the base-speed multiplier, because the owner's "speed multiplier should be on
// literally time for the entire start to finish of making the move" includes the hand's movement.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { SETTINGS_RANGES } from "@core/constants/limits";
import { SETTING_GAIN } from "@core/constants/setting-gain";
import { boundedMotorSpeed } from "@core/motor/motor-profile";
import { executorSettingsFor } from "@service/game-session/executor-settings";
import type { Settings } from "@typedefs/settings";

const execution = (patch: Partial<Settings["execution"]> = {}): Settings["execution"] => ({
	...DEFAULT_SETTINGS.execution,
	...patch,
});

const timing = (patch: Partial<Settings["timing"]> = {}): Settings["timing"] => ({
	...DEFAULT_SETTINGS.timing,
	...patch,
});

describe("executorSettingsFor", () => {
	it("the effective value is the user's number times the gain", () => {
		for (const motorSpeed of [0.5, 1, 1.45, 2]) {
			for (const previewSelectScale of [0.5, 1, 1.7, 2]) {
				expect(executorSettingsFor(execution({ motorSpeed, previewSelectScale }), timing())).toEqual({
					motorSpeed: motorSpeed * SETTING_GAIN.motorSpeed,
					previewScale: previewSelectScale * SETTING_GAIN.previewSelectScale,
				});
			}
		}
	});

	it("the default install runs at the instructed effective values", () => {
		// `previewScale` is 1.10, not the instructed 1.25: at 1.25 the pooled multi-select rate is
		// 13.30 % against the §13.2 band's 12 % ceiling (`SETTING_GAIN.previewSelectScale` carries
		// the sweep). Read from the registry so the two cannot drift.
		expect(executorSettingsFor(DEFAULT_SETTINGS.execution, DEFAULT_SETTINGS.timing)).toEqual({
			motorSpeed: 1.15,
			previewScale: SETTING_GAIN.previewSelectScale,
		});
		expect(SETTING_GAIN.previewSelectScale).toBe(1.1);
	});

	// ── base speed reaches the hand (owner, 2026-09-15) ───────────────────────────────────────
	it("base speed multiplies the hand's speed, composing with the motor slider", () => {
		// Updated 2026-09-15: before the base-speed rework this function took `execution` alone and
		// the timing sliders never touched the hand. They must now, or "the entire start to finish
		// of making the move" would exclude the part where the hand actually moves.
		const base = executorSettingsFor(execution(), timing()).motorSpeed;
		for (const baseSpeed of [0.5, 1, 2, 3]) {
			expect(executorSettingsFor(execution(), timing({ baseSpeed })).motorSpeed).toBeCloseTo(
				base * baseSpeed,
				12
			);
		}
		// Composed with the user's own hand slider, not replacing it.
		expect(
			executorSettingsFor(execution({ motorSpeed: 1.5 }), timing({ baseSpeed: 2 })).motorSpeed
		).toBeCloseTo(1.5 * SETTING_GAIN.motorSpeed * 2, 12);
		// Higher base speed is a faster hand, in the direction the setting name promises.
		expect(executorSettingsFor(execution(), timing({ baseSpeed: 4 })).motorSpeed).toBeGreaterThan(
			executorSettingsFor(execution(), timing({ baseSpeed: 0.35 })).motorSpeed
		);
		// A stored value outside the slider, or not a number at all, cannot move the hand: the
		// range clamp lives in `effectiveBaseSpeed`, one definition for the wait and the hand.
		expect(executorSettingsFor(execution(), timing({ baseSpeed: 99 })).motorSpeed).toBe(
			base * SETTINGS_RANGES.baseSpeed.max
		);
		expect(executorSettingsFor(execution(), timing({ baseSpeed: 0 })).motorSpeed).toBe(
			base * SETTINGS_RANGES.baseSpeed.min
		);
		expect(
			executorSettingsFor(execution(), timing({ baseSpeed: Number.NaN })).motorSpeed
		).toBeCloseTo(base, 12);
	});

	it("§13.2: no base speed can drive the pointer outside the hand's human band", () => {
		const { min, max } = SETTINGS_RANGES.motorSpeed;
		const floor = min * SETTING_GAIN.motorSpeed;
		const ceiling = max * SETTING_GAIN.motorSpeed;
		for (const baseSpeed of [SETTINGS_RANGES.baseSpeed.min, 1, SETTINGS_RANGES.baseSpeed.max])
			for (const motorSpeed of [min, 1, max]) {
				const effective = boundedMotorSpeed(
					executorSettingsFor(execution({ motorSpeed }), timing({ baseSpeed })).motorSpeed
				);
				expect(effective).toBeGreaterThanOrEqual(floor);
				expect(effective).toBeLessThanOrEqual(ceiling);
			}
		// The fastest the hand can ever be told to move, and the slowest.
		expect(
			boundedMotorSpeed(
				executorSettingsFor(execution({ motorSpeed: max }), timing({ baseSpeed: 4 })).motorSpeed
			)
		).toBe(ceiling);
		expect(
			boundedMotorSpeed(
				executorSettingsFor(execution({ motorSpeed: min }), timing({ baseSpeed: 0.35 })).motorSpeed
			)
		).toBe(floor);
	});

	it("the slider's 0 is Off and stays exactly 0 through the gain (settings layout, 2026-09-13)", () => {
		expect(executorSettingsFor(execution({ previewSelectScale: 0 }), timing()).previewScale).toBe(0);
		expect(executorSettingsFor(execution({ previewSelectScale: -1 }), timing()).previewScale).toBe(0);
		expect(
			executorSettingsFor(execution({ previewSelectScale: 0.05 }), timing()).previewScale
		).toBeCloseTo(0.05 * SETTING_GAIN.previewSelectScale);
	});

	it("the hand's clamp is the slider's range in effective units, so the top ticks stay distinct", () => {
		const { min, max, step } = SETTINGS_RANGES.motorSpeed;
		expect(
			boundedMotorSpeed(executorSettingsFor(execution({ motorSpeed: max }), timing()).motorSpeed)
		).toBe(max * SETTING_GAIN.motorSpeed);
		expect(
			boundedMotorSpeed(executorSettingsFor(execution({ motorSpeed: min }), timing()).motorSpeed)
		).toBe(min * SETTING_GAIN.motorSpeed);
		const top = boundedMotorSpeed(
			executorSettingsFor(execution({ motorSpeed: max }), timing()).motorSpeed
		);
		const below = boundedMotorSpeed(
			executorSettingsFor(execution({ motorSpeed: max - step }), timing()).motorSpeed
		);
		expect(top).toBeGreaterThan(below);
		// outside the range is still clamped; a missing speed is still the identity
		expect(boundedMotorSpeed(99)).toBe(max * SETTING_GAIN.motorSpeed);
		expect(boundedMotorSpeed(0)).toBe(min * SETTING_GAIN.motorSpeed);
		expect(boundedMotorSpeed(undefined)).toBe(1);
	});
});
