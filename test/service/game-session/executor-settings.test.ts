// test/service/game-session/executor-settings.test.ts — the hand's two sliders as the executor
// runs them: `user × SETTING_GAIN` (owner, 2026-09-13), previews off → 0.
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

describe("executorSettingsFor", () => {
	it("the effective value is the user's number times the gain", () => {
		for (const motorSpeed of [0.5, 1, 1.45, 2]) {
			for (const previewSelectScale of [0.5, 1, 1.7, 2]) {
				expect(executorSettingsFor(execution({ motorSpeed, previewSelectScale }))).toEqual({
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
		expect(executorSettingsFor(DEFAULT_SETTINGS.execution)).toEqual({
			motorSpeed: 1.15,
			previewScale: SETTING_GAIN.previewSelectScale,
		});
		expect(SETTING_GAIN.previewSelectScale).toBe(1.1);
	});

	it("the slider's 0 is Off and stays exactly 0 through the gain (settings layout, 2026-09-13)", () => {
		expect(executorSettingsFor(execution({ previewSelectScale: 0 })).previewScale).toBe(0);
		expect(executorSettingsFor(execution({ previewSelectScale: -1 })).previewScale).toBe(0);
		expect(executorSettingsFor(execution({ previewSelectScale: 0.05 })).previewScale).toBeCloseTo(
			0.05 * SETTING_GAIN.previewSelectScale
		);
	});

	it("the hand's clamp is the slider's range in effective units, so the top ticks stay distinct", () => {
		const { min, max, step } = SETTINGS_RANGES.motorSpeed;
		expect(boundedMotorSpeed(executorSettingsFor(execution({ motorSpeed: max })).motorSpeed)).toBe(
			max * SETTING_GAIN.motorSpeed
		);
		expect(boundedMotorSpeed(executorSettingsFor(execution({ motorSpeed: min })).motorSpeed)).toBe(
			min * SETTING_GAIN.motorSpeed
		);
		const top = boundedMotorSpeed(executorSettingsFor(execution({ motorSpeed: max })).motorSpeed);
		const below = boundedMotorSpeed(
			executorSettingsFor(execution({ motorSpeed: max - step })).motorSpeed
		);
		expect(top).toBeGreaterThan(below);
		// outside the range is still clamped; a missing speed is still the identity
		expect(boundedMotorSpeed(99)).toBe(max * SETTING_GAIN.motorSpeed);
		expect(boundedMotorSpeed(0)).toBe(min * SETTING_GAIN.motorSpeed);
		expect(boundedMotorSpeed(undefined)).toBe(1);
	});
});
