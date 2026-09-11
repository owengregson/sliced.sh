/**
 * Blunder channel of §7.2 step 6 (Appendix E §1.5 "blunder injection"):
 * `b(E, ctx) = b0(E)·f_clock·f_complexity`, scaled by `Settings.strength.blunderScale`
 * and damped ×0.3 for the 3 moves after an injected blunder; a two-component
 * target-loss draw and the nearest-loss candidate weighted by prior.
 */

import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { SELECTION_CONSTANTS as C } from "./constants";
import { b0For } from "./elo-map";
import type { SelectionState } from "./types";

export interface BlunderInputs {
	myClockMs: number;
	/**
	 * The game's starting clock in ms, when it is known. Absent or 0 — an untimed game, or a time
	 * control the page has not answered yet — keeps the absolute `clockPressureMs` curve alone.
	 */
	baseMs?: number;
	/** Population std of the (jittered) `cpEff` over the top-K lines. */
	cpStd: number;
	blunderScale: number;
	state: Pick<SelectionState, "blunderDamperLeft">;
}

export interface BlunderTerms {
	b0: number;
	fClock: number;
	fComplexity: number;
	damper: number;
	/** The final per-move probability. */
	b: number;
}

/**
 * `f_clock`: the larger of the absolute §7.2 ramp and the same ramp expressed as a fraction of the
 * game's own base clock. A `max`, so the rate never falls below what it is without the relative term
 * — the late game is unchanged — and `baseMs` absent or 0 leaves the absolute curve exactly alone.
 */
function clockFactor(myClockMs: number, baseMs: number | undefined): number {
	const { clockPressureMs, clockGain, clockPressureFraction } = C.blunder;
	const absolute = clamp((clockPressureMs - myClockMs) / clockPressureMs, 0, 1);
	const relative =
		baseMs !== undefined && baseMs > 0
			? clamp((clockPressureFraction - clamp(myClockMs / baseMs, 0, 1)) / clockPressureFraction, 0, 1)
			: 0;
	return 1 + clockGain * Math.max(absolute, relative);
}

export function blunderTerms(E: number, inputs: BlunderInputs): BlunderTerms {
	const { complexityGain, complexityStdCp } = C.blunder;
	const b0 = b0For(E);
	const fClock = clockFactor(inputs.myClockMs, inputs.baseMs);
	const fComplexity = 1 + complexityGain * (inputs.cpStd >= complexityStdCp ? 1 : 0);
	const damper = inputs.state.blunderDamperLeft > 0 ? C.blunder.damperMultiplier : 1;
	const b = b0 * fClock * fComplexity * inputs.blunderScale * damper;
	return { b0, fClock, fComplexity, damper, b: Math.max(0, b) };
}

/** `b(E, ctx)` — the probability that this move comes from the error distribution. */
export function blunderProbability(E: number, inputs: BlunderInputs): number {
	return blunderTerms(E, inputs).b;
}

export interface TargetLoss {
	kind: "mistake" | "blunder";
	/** Target loss in win-fraction units. */
	target: number;
}

/** 65 %: U(0.10, 0.30) "mistake"; 35 %: U(0.30, 0.70) "blunder". */
export function drawTargetLoss(rng: Rng): TargetLoss {
	const mistake = rng.next() < C.blunder.mistakeProb;
	const [lo, hi] = mistake ? C.blunder.mistakeLoss : C.blunder.blunderLoss;
	return { kind: mistake ? "mistake" : "blunder", target: lo + rng.next() * (hi - lo) };
}

export interface BlunderCandidate {
	uci: string;
	loss: number;
	prior: number;
}

/**
 * The candidate whose loss is nearest `target`, weighted by prior
 * (`argmin |loss − target| / max(prior, 0.02)`); `null` on an empty pool.
 */
export function pickBlunder<T extends BlunderCandidate>(
	pool: readonly T[],
	target: number
): T | null {
	let best: T | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const c of pool) {
		const score = Math.abs(c.loss - target) / Math.max(c.prior, C.blunder.priorFloor);
		if (score < bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best;
}
