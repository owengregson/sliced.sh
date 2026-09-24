/** The §9.3a preview rate: `p_preview = clamp(base · f(n_reasonable) · g(thinkMs) · scale, 0, cap)`. */
import type { PersonaId } from "@typedefs/settings";
import type { TimingMode } from "@typedefs/timing";
import { PREVIEW } from "../constants";

export interface PreviewContext {
	persona: PersonaId;
	nReasonable: number;
	thinkMs: number;
	mode: TimingMode;
	myClockMs: number;
	/** `Settings.execution.previewSelectScale` (0 when previews are off). */
	previewScale: number;
	/** The profile's `exploration.previewBase` (fitted profiles may override the persona table). */
	previewBase?: number;
}

/** `g(thinkMs)`: 0 below 1 200 ms, 1 at 4 s, 1.6 at 10 s (linear ramps, flat beyond). */
export function thinkRamp(thinkMs: number): number {
	if (thinkMs < PREVIEW.gZeroMs) return 0;
	if (thinkMs <= PREVIEW.gOneMs)
		return (thinkMs - PREVIEW.gZeroMs) / (PREVIEW.gOneMs - PREVIEW.gZeroMs);
	if (thinkMs >= PREVIEW.gMaxMs) return PREVIEW.gMaxValue;
	return (
		1 + ((thinkMs - PREVIEW.gOneMs) / (PREVIEW.gMaxMs - PREVIEW.gOneMs)) * (PREVIEW.gMaxValue - 1)
	);
}

/**
 * `p_preview = clamp(base · f(n_reasonable) · g(thinkMs) · scale, 0, 0.35)`; the scale is
 * applied before the cap (ruling). 0 in premove/instant modes and below the clock floor.
 */
export function previewProbability(ctx: PreviewContext): number {
	if (ctx.mode === "premove" || ctx.mode === "instant") return 0;
	if (ctx.myClockMs < PREVIEW.clockFloorMs) return 0;
	if (!(ctx.previewScale > 0)) return 0;
	const base = ctx.previewBase ?? PREVIEW.base[ctx.persona];
	const f = 1 + PREVIEW.fSlope * (Math.max(1, ctx.nReasonable) - 1);
	const p = base * f * thinkRamp(ctx.thinkMs) * ctx.previewScale;
	return Math.min(PREVIEW.cap, Math.max(0, p));
}
