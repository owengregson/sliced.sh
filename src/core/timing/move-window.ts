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
	/** Emergency regime (§8.5): the physical phases compress proportionally below their floors. */
	emergency?: boolean;
}

/**
 * Split `thinkMs` into the five phase budgets; the sum equals `thinkMs` exactly.
 * The sampled total is the master (Appendix D §3a.6): when it is shorter than
 * orientation + motor, both are compressed into it proportionally with the
 * orientation floor (150 ms) and the motor floor (60 ms); the decision pause
 * is 15–40 % of whatever remains after them.
 */
export function allocateWindow(input: WindowInputs, rng: Rng): MoveWindowBudget {
	const think = Math.max(0, input.thinkMs);
	if (input.mode === "premove")
		return { orientationMs: 0, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: think };
	const [orientationMs, approachMs] = compressPhysical(
		think,
		input.orientationMs,
		input.motorMs,
		input.emergency === true
	);
	if (input.mode === "instant") {
		// No scan, preview or decision pause: whatever is left is perceptual/reaction latency.
		return { orientationMs: think - approachMs, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs };
	}
	const rest = Math.max(0, think - orientationMs - approachMs);
	const decisionMs = uniform(rng, W.decisionMin, W.decisionMax) * rest;
	const explore = rest - decisionMs;
	const previewMs =
		input.previewCount > 0 ? explore * Math.min(1, W.previewShare * input.previewCount) : 0;
	// The scan absorbs the remainder so the five budgets sum to `think` exactly.
	const scanMs = Math.max(0, think - orientationMs - approachMs - decisionMs - previewMs);
	return { orientationMs, scanMs, previewMs, decisionMs, approachMs };
}

/** `[orientation, approach]` fitted into `think` with the 150 ms / 60 ms floors. */
function compressPhysical(
	think: number,
	orientationMs: number,
	motorMs: number,
	emergency: boolean
): [number, number] {
	if (think >= orientationMs + motorMs) return [orientationMs, motorMs];
	const minM = M.minMotorMs;
	const scale = think / Math.max(1e-9, orientationMs + motorMs);
	if (emergency) {
		// Minimal motor, everything else proportional — no orientation floor.
		const a = Math.max(Math.min(minM, think), motorMs * scale);
		return [Math.max(0, think - a), a];
	}
	const minO = TIMING_CONSTANTS.orientation.minMs;
	let o = Math.max(minO, orientationMs * scale);
	let a = Math.max(minM, motorMs * scale);
	if (o + a > think) {
		a = clamp(think - o, Math.min(minM, think), think);
		o = Math.max(0, think - a);
	}
	return [o, a];
}

/** Sum of the phase budgets (for invariants and tests). */
export function windowTotalMs(w: MoveWindowBudget): number {
	return w.orientationMs + w.scanMs + w.previewMs + w.decisionMs + w.approachMs;
}
