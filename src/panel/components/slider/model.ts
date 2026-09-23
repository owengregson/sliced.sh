/** The slider's arithmetic, free of the DOM: snapping, track positions, keyboard steps, heat. */

import { STRENGTH_UI, UI_TIMINGS } from "@core/constants/ui";
import { clamp } from "@core/util/clamp";
import { TOKENS } from "@design/tokens.generated";

export interface SliderRange {
	min: number;
	max: number;
	step: number;
}

/** `raw` snapped to the nearest step from `min`, at the step's own precision, and clamped. */
export function snapValue(raw: number, { min, max, step }: SliderRange): number {
	const stepped = Math.round((raw - min) / step) * step + min;
	const decimals = (String(step).split(".")[1] ?? "").length;
	return clamp(Number(stepped.toFixed(decimals)), min, max);
}

/** A value as the slider holds it: snapped to the step, or clamped only for an exact reading. */
export function fitValue(raw: number, asGiven: boolean, range: SliderRange): number {
	return asGiven ? clamp(raw, range.min, range.max) : snapValue(raw, range);
}

/** Track position of `at` as a CSS percentage, clamped to the range. */
export function percentOf(at: number, min: number, max: number): string {
	return `${(max > min ? clamp((at - min) / (max - min), 0, 1) * 100 : 0).toFixed(3)}%`;
}

/**
 * The value a slider key moves to, or `null` for a key the slider does not handle. Arrow keys
 * step (Shift ×`sliderCoarseMultiplier`), PageUp/Down always coarse, Home/End to the ends.
 */
export function keyTarget(
	key: string,
	shiftKey: boolean,
	value: number,
	{ min, max, step }: SliderRange
): number | null {
	const coarse = step * UI_TIMINGS.sliderCoarseMultiplier;
	const fine = shiftKey ? coarse : step;
	switch (key) {
		case "ArrowRight":
		case "ArrowUp":
			return value + fine;
		case "ArrowLeft":
		case "ArrowDown":
			return value - fine;
		case "PageUp":
			return value + coarse;
		case "PageDown":
			return value - coarse;
		case "Home":
			return min;
		case "End":
			return max;
		default:
			return null;
	}
}

/** Hot-range energy of a strength slider: 0 at `STRENGTH_UI.glowElo` → 1 at the maximum. */
export function strengthEnergy(value: number, max: number): number {
	return max > STRENGTH_UI.glowElo
		? clamp((value - STRENGTH_UI.glowElo) / (max - STRENGTH_UI.glowElo), 0, 1)
		: 0;
}

/** The strength slider's tick marks: every `STRENGTH_UI.sliderTickStep` inside the range. */
export function strengthTicks(min: number, max: number): Array<{ value: number; left: string }> {
	const ticks: Array<{ value: number; left: string }> = [];
	for (
		let mark = Math.ceil(min / STRENGTH_UI.sliderTickStep) * STRENGTH_UI.sliderTickStep;
		mark <= max;
		mark += STRENGTH_UI.sliderTickStep
	) {
		if (mark < min) continue;
		ticks.push({ value: mark, left: `${(((mark - min) / (max - min)) * 100).toFixed(3)}%` });
	}
	return ticks;
}

/**
 * The wait before the next warm sweep, from the energy at this moment. Each sweep is one CSS
 * crossing of a fixed `strength-sweep` duration; only the wait between launches follows the
 * energy. The sweeps take turns, so the per-sweep period (`sweepTravelWidths + gap` widths at
 * the fixed speed) is shared between them.
 */
export function sweepDelayMs(energy: number, sweeps: number): number {
	const gap = STRENGTH_UI.flowGapMax - (STRENGTH_UI.flowGapMax - STRENGTH_UI.flowGapMin) * energy;
	const travel = STRENGTH_UI.sweepTravelWidths;
	return (
		(TOKENS.motion.durationMs["strength-sweep"] * (travel + gap)) / (travel * Math.max(1, sweeps))
	);
}
