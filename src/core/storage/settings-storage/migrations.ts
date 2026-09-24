/**
 * Readers for settings whose stored shape changed: they accept the old spelling and read it
 * into the current one. There is no schema version field, so each infers the migration from
 * the stored object itself.
 */

import { LIMITS, SETTINGS_RANGES } from "@core/constants/limits";
import { clamp } from "@core/util/clamp";
import { numIn, type Obj } from "./readers";

/**
 * Settings layout, 2026-09-13: the `execution.previewSelects` segment ("auto" | "off") folded
 * into the rate slider, whose 0 is Off. A profile stored before that maps `"off"` to 0 and keeps
 * the stored rate otherwise; the old key itself never comes back.
 */
export function previewSelectScale(execution: Obj, d: number): number {
	if (execution.previewSelects === "off") return LIMITS.previewSelectScaleMin;
	return numIn(
		execution.previewSelectScale,
		d,
		LIMITS.previewSelectScaleMin,
		LIMITS.previewSelectScaleMax
	);
}

/**
 * Base speed, 2026-09-15: `timing.speedScale` (higher = *slower*, it multiplied a duration)
 * became `timing.baseSpeed` (higher = faster) when the owner pointed out the knob was backwards.
 * There is no schema version field, so the migration is inferred from the stored object itself: a
 * finite `baseSpeed` wins; failing that a finite, positive `speedScale` becomes its reciprocal,
 * clamped to the new range and **rounded to 2 decimals** — so the old 1.3 imports as 0.77 and the
 * old 0.5 as 2. Pace is preserved to within the rounding (at most 0.5 %); 2 decimals rather than
 * the slider's 0.05 step because a reciprocal is rarely on that grid and halving the error costs
 * nothing — the panel snaps the value to a tick on the next drag. Neither key present (or a
 * garbage one) reads the default.
 */
export function baseSpeed(timing: Obj, d: number): number {
	const { min, max } = SETTINGS_RANGES.baseSpeed;
	if (typeof timing.baseSpeed === "number" && Number.isFinite(timing.baseSpeed))
		return clamp(timing.baseSpeed, min, max);
	const legacy = timing.speedScale;
	if (typeof legacy === "number" && Number.isFinite(legacy) && legacy > 0)
		return Math.round(clamp(1 / legacy, min, max) * 100) / 100;
	return d;
}
