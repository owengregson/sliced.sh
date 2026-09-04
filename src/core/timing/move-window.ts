/**
 * The move window as one generative process (§8.4b item 3) and the motor
 * split (Appendix D §3a.6). Given the sampled `thinkMs` budget, the mode and
 * the motor time, `allocateWindow` splits the window into
 * `orientation → scan → [preview] → decision pause → approach`, summing
 * exactly to `thinkMs`, with the committed approach always last and the
 * decision pause (no pointer motion, 15–40 % of the window) right before it.
 * Hover *content* (which pieces are scanned / previewed) is the motor
 * planner's job (Tasks 17/18); this module only produces the budgets.
 */

import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";
import { logNormal, uniform } from "./distributions";
import type { Features, MoveWindowBudget, Persona, TimingMode } from "./types";

const M = TIMING_CONSTANTS.motor;
const W = TIMING_CONSTANTS.window;

export const WINDOW_PHASE_ORDER = [
	"orientation",
	"scan",
	"preview",
	"decision",
	"approach",
] as const;

export interface MotorInputs {
	inputMethod: "drag" | "click";
	autoQueen: boolean;
}

export interface MotorTimes {
	hoverS: number;
	dragS: number;
	promoS: number;
	totalS: number;
}

/** Appendix D §3a.6: hover, Fitts-like drag (or two-click gap) and the promotion delay. */
export function motorModel(
	f: Pick<Features, "dist" | "is_promotion">,
	input: MotorInputs,
	persona: Pick<Persona, "motor_k">,
	rng: Rng
): MotorTimes {
	const hoverS = logNormal(rng, M.hoverMedianS, M.hoverSigma) * persona.motor_k;
	const dragS =
		input.inputMethod === "click"
			? (M.clickBaseS + M.clickLogS * Math.log2(1 + f.dist)) * persona.motor_k
			: clamp(
					(M.dragBaseS + M.dragLogS * Math.log2(1 + f.dist) + rng.normal(0, M.dragSdS)) *
						persona.motor_k,
					M.dragMinS,
					M.dragMaxS
				);
	const promoS = f.is_promotion && !input.autoQueen ? uniform(rng, M.promoS[0], M.promoS[1]) : 0;
	return { hoverS, dragS, promoS, totalS: hoverS + dragS + promoS };
}

export interface WindowInputs {
	thinkMs: number;
	mode: TimingMode;
	/** Sampled orientation latency (may be compressed when the window is short). */
	orientationMs: number;
	/** Motor time (hover + drag + promotion) — the approach budget. */
	motorMs: number;
	/** Number of preview selections the planner intends (0 for none). */
	previewCount: number;
}

/** Split `thinkMs` into the five phase budgets; the sum equals `thinkMs` exactly. */
export function allocateWindow(input: WindowInputs, rng: Rng): MoveWindowBudget {
	const think = Math.max(0, input.thinkMs);
	if (input.mode === "premove")
		return { orientationMs: 0, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: think };
	if (input.mode === "instant") {
		const approachMs = Math.min(input.motorMs, think);
		return { orientationMs: think - approachMs, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs };
	}
	// Decision pause 15–40 % of the window, squeezed toward 15 % when orientation + approach
	// need the room (the model floors normal windows so that this fits).
	const maxFrac = Math.max(
		W.decisionMin,
		Math.min(W.decisionMax, 1 - (input.orientationMs + input.motorMs) / Math.max(1, think))
	);
	const decisionMs =
		clamp(uniform(rng, W.decisionMin, W.decisionMax), W.decisionMin, maxFrac) * think;
	const approachMs = Math.min(input.motorMs, think - decisionMs);
	let rest = think - decisionMs - approachMs;
	const orientationMs = Math.min(input.orientationMs, rest);
	rest -= orientationMs;
	const previewMs =
		input.previewCount > 0 ? rest * Math.min(1, W.previewShare * input.previewCount) : 0;
	const scanMs = rest - previewMs;
	return { orientationMs, scanMs, previewMs, decisionMs, approachMs };
}

/** Sum of the phase budgets (for invariants and tests). */
export function windowTotalMs(w: MoveWindowBudget): number {
	return w.orientationMs + w.scanMs + w.previewMs + w.decisionMs + w.approachMs;
}
