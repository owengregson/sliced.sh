/**
 * Elo → engine option, E-band helpers and score normalisation (Task 14). Every band is a pure
 * function of `SELECTION_CONSTANTS`.
 */

import { LIMITS } from "@core/constants/limits";
import { clamp } from "@core/util/clamp";
import type { Eval } from "@typedefs/engine";
import { SELECTION_CONSTANTS as C } from "./constants";

/** `UCI_Elo` for a target: clamped to the engine's supported range (§7.1). */
export function engineEloFor(targetElo: number): number {
	return clamp(targetElo, LIMITS.engineEloMin, LIMITS.engineEloMax);
}

/** §7.2 step 1: `E = clamp(targetElo + 150·form, eloMin, eloMax)`. */
export function effectiveElo(targetElo: number, form: number): number {
	return clamp(targetElo + C.form.eloPerUnit * form, LIMITS.eloMin, LIMITS.eloMax);
}

/** §7.2 step 3: perception-noise σ(E) in cp. */
export function sigmaFor(E: number): number {
	const { base, range, pivotElo, span } = C.sigma;
	return base + range * clamp((pivotElo - E) / span, 0, 1);
}

/** §7.2 step 7: softmax temperature τ(E) in win-fraction units (streak term excluded). */
export function tauFor(E: number): number {
	const { base, range, pivotElo, span, min, max } = C.tau;
	return clamp(base + range * ((pivotElo - E) / span) ** 2, min, max);
}

/** §7.2 step 7: gap cutoff G(E) in cp. */
export function gapFor(E: number): number {
	const { base, range, pivotElo, span } = C.gap;
	return base + range * clamp((pivotElo - E) / span, 0, 1);
}

/** §7.2 step 7: prior exponent β(E). */
export function betaFor(E: number): number {
	const { bands, values } = C.beta;
	for (let i = 0; i < bands.length; i++) {
		const edge = bands[i];
		const value = values[i];
		if (edge !== undefined && value !== undefined && E < edge) return value;
	}
	return values[values.length - 1] ?? 0;
}

/** §7.2 step 6: base blunder rate b0(E) — flat outside the table, linear between knots. */
export function b0For(E: number): number {
	const knots = C.blunder.b0;
	const first = knots[0];
	const last = knots[knots.length - 1];
	if (first === undefined || last === undefined) return 0;
	if (E <= first[0]) return first[1];
	if (E >= last[0]) return last[1];
	for (let i = 1; i < knots.length; i++) {
		const lo = knots[i - 1];
		const hi = knots[i];
		if (lo === undefined || hi === undefined) continue;
		if (E <= hi[0]) {
			const t = (E - lo[0]) / (hi[0] - lo[0]);
			return lo[1] + t * (hi[1] - lo[1]);
		}
	}
	return last[1];
}

/** Linear ramp between two (Elo, value) points, flat outside. */
export function eloRamp(E: number, loElo: number, loValue: number, hiElo: number, hiValue: number) {
	if (E < loElo) return loValue;
	if (E >= hiElo) return hiValue;
	return loValue + ((E - loElo) / (hiElo - loElo)) * (hiValue - loValue);
}

/** §7.2 step 4: lichess win probability `1/(1 + e^(−0.00368208·cp))`. */
export function winProb(cp: number): number {
	return 1 / (1 + Math.exp(-C.score.winProbK * cp));
}

/** §7.2 step 2: cp clamped ±`LIMITS.cpClamp`; mate → `±(1000 + (100 − |mate|))` with sign. */
export function cpEffective(score: Eval): number {
	const { mateCpBase, mateHorizon } = C.score;
	if (score.mate !== undefined && score.mate !== 0) {
		const magnitude = mateCpBase + (mateHorizon - Math.abs(score.mate));
		return score.mate > 0 ? magnitude : -magnitude;
	}
	return clamp(score.cp ?? 0, -LIMITS.cpClamp, LIMITS.cpClamp);
}
