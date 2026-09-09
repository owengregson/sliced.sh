/**
 * Sampling helpers over `Rng` (Appendix D §3a / §4). Every stochastic function
 * takes the `Rng` explicitly; nothing here touches `Math.random`.
 */

import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";

/** Log-normal with the given *median* and log-scale σ. */
export function logNormal(rng: Rng, median: number, sigma: number): number {
	return median * Math.exp(sigma * rng.normal());
}

/** Pareto(α, x_m): `x_m · (1 − u)^(−1/α)`, always ≥ `x_m`. */
export function pareto(rng: Rng, alpha: number, xm = 1): number {
	const u = rng.next();
	return xm / (1 - u) ** (1 / alpha);
}

export function sigmoid(x: number): number {
	if (x >= 0) return 1 / (1 + Math.exp(-x));
	const e = Math.exp(x);
	return e / (1 + e);
}

/** Normal(μ, σ) truncated to `[lo, hi]`: rejection sampling, clamped after 64 tries. */
export function truncNormal(rng: Rng, mu: number, sigma: number, lo: number, hi: number): number {
	for (let i = 0; i < 64; i++) {
		const x = rng.normal(mu, sigma);
		if (x >= lo && x <= hi) return x;
	}
	return clamp(rng.normal(mu, sigma), lo, hi);
}

/** Gamma(shape ≥ 1, scale 1) by Marsaglia–Tsang; shapes < 1 use the boost `U^(1/a)`. */
function gamma(rng: Rng, shape: number): number {
	if (shape < 1) return gamma(rng, shape + 1) * rng.next() ** (1 / shape);
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	for (;;) {
		const x = rng.normal();
		const v = (1 + c * x) ** 3;
		if (v <= 0) continue;
		const u = rng.next();
		if (u < 1 - 0.0331 * x ** 4) return d * v;
		if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
	}
}

/** Beta(a, b) as `X / (X + Y)` with gamma variates; strictly inside (0, 1). */
export function beta(rng: Rng, a: number, b: number): number {
	const x = gamma(rng, a);
	const y = gamma(rng, b);
	const r = x / (x + y);
	return clamp(r, Number.EPSILON, 1 - Number.EPSILON);
}

/** Exponential with the given mean (inverse CDF; `1 - u` keeps the log finite). */
export function exponential(rng: Rng, mean: number): number {
	return -mean * Math.log(1 - rng.next());
}

/** Uniform in `[lo, hi)`. */
export function uniform(rng: Rng, lo: number, hi: number): number {
	return lo + (hi - lo) * rng.next();
}
