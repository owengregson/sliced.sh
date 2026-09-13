// test/core/constants/setting-gain.test.ts — the internal gains on the user's sliders (owner,
// 2026-09-13): the values, the arithmetic they were derived from, and the premove map.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { SETTINGS_RANGES } from "@core/constants/limits";
import { effectivePremoveTendency, SETTING_GAIN } from "@core/constants/setting-gain";
import { SETTINGS_COPY } from "@panel/copy";
import { rowFor } from "@panel/views/settings/rows";

describe("SETTING_GAIN (owner, 2026-09-13)", () => {
	it("carries the instructed multipliers", () => {
		// 1.25 as instructed, trimmed to the largest value the §13.2 multi-select band allows: at
		// 1.25 the pooled rate is 13.30 % against a 12 % ceiling, at 1.10 it is 11.45 %
		// (`SETTING_GAIN.previewSelectScale` carries the sweep).
		expect(SETTING_GAIN.previewSelectScale).toBe(1.1);
		expect(SETTING_GAIN.previewSelectScale).toBeLessThan(1.25);
		expect(SETTING_GAIN.longThinkFrequency).toBe(0.8);
		// Per time-control class since the 2026-09-13 clock work: the instructed 1.3 stands where
		// there is room for it, and bullet/blitz run at 1.0 because 1.3 was measurably losing 3+0
		// games on the clock (docs/research/chessmimic-bands-and-the-clock-2026-09-13.md).
		expect(SETTING_GAIN.speedScale).toEqual({
			bullet: 1,
			blitz: 1,
			rapid: 1.3,
			classical: 1.3,
			untimed: 1.3,
		});
		expect(SETTING_GAIN.motorSpeed).toBe(1.15);
	});

	it("the user-visible defaults are the round numbers the gains are re-basing", () => {
		expect(DEFAULT_SETTINGS.execution.previewSelectScale).toBe(1);
		expect(DEFAULT_SETTINGS.execution.motorSpeed).toBe(1);
		expect(DEFAULT_SETTINGS.timing.speedScale).toBe(1);
		expect(DEFAULT_SETTINGS.timing.longThinkFrequency).toBe(1);
		expect(DEFAULT_SETTINGS.timing.premoveTendency).toBe(0.5);
	});

	it("the persona offset is shifted visibly, not gained", () => {
		expect(DEFAULT_SETTINGS.strength.personaEloOffset).toBe(150);
		expect("personaEloOffset" in SETTING_GAIN).toBe(false);
	});

	it("motor speed: the default Natural runs one slider tick before Fast", () => {
		// The derivation: `gain × default` must be the last tick the panel still labels Natural,
		// and one `step` above it must be the first tick it labels Fast.
		const row = rowFor("execution.motorSpeed");
		if (row.kind !== "slider") throw new Error("motorSpeed is a slider row");
		const { step } = SETTINGS_RANGES.motorSpeed;
		const effective = DEFAULT_SETTINGS.execution.motorSpeed * SETTING_GAIN.motorSpeed;
		expect(row.format(effective)).toBe(SETTINGS_COPY.format.motor.natural);
		expect(row.format(effective + step)).toBe(SETTINGS_COPY.format.motor.fast);
		// … and it is on the slider's own grid.
		expect(Math.round(effective / step) * step).toBeCloseTo(effective, 10);
	});

	it("premove tendency: the piecewise map hits its knots and keeps the ends meaningful", () => {
		expect(SETTING_GAIN.premoveTendency.knots).toEqual([
			[0, 0],
			[0.5, 0.8],
			[1, 1],
		]);
		expect(effectivePremoveTendency(0)).toBe(0);
		expect(effectivePremoveTendency(DEFAULT_SETTINGS.timing.premoveTendency)).toBeCloseTo(0.8, 12);
		expect(effectivePremoveTendency(1)).toBe(1);
		// linear between the knots
		expect(effectivePremoveTendency(0.25)).toBeCloseTo(0.4, 12);
		expect(effectivePremoveTendency(0.75)).toBeCloseTo(0.9, 12);
	});

	it("premove tendency: monotone over the slider and clamped outside it", () => {
		const { min, max, step } = SETTINGS_RANGES.premoveTendency;
		let prev = effectivePremoveTendency(min);
		for (let u = min + step; u <= max + step / 2; u += step) {
			const v = effectivePremoveTendency(u);
			expect(v).toBeGreaterThan(prev);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
			prev = v;
		}
		expect(effectivePremoveTendency(-1)).toBe(0);
		expect(effectivePremoveTendency(2)).toBe(1);
		expect(effectivePremoveTendency(Number.NaN)).toBe(0);
	});
});
