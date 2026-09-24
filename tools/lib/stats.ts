/**
 * tools/lib/stats.ts — the small statistics the reports share: a running mean, a correlation over
 * pairs, a linearly interpolated percentile and a seeded bootstrap of the mean.
 */

import { createRng } from "@core/rng";

/** A running arithmetic mean; `value` is `null` until something was added. */
export class Mean {
	sum = 0;
	n = 0;
	add(v: number): void {
		this.sum += v;
		this.n++;
	}
	get value(): number | null {
		return this.n === 0 ? null : this.sum / this.n;
	}
}

/** Pearson's r over `(x, y)` pairs; `null` under three pairs or when either side is constant. */
export function pearson(pairs: Array<[number, number]>): number | null {
	if (pairs.length < 3) return null;
	let mx = 0;
	let my = 0;
	for (const [x, y] of pairs) {
		mx += x;
		my += y;
	}
	mx /= pairs.length;
	my /= pairs.length;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (const [x, y] of pairs) {
		sxy += (x - mx) * (y - my);
		sxx += (x - mx) ** 2;
		syy += (y - my) ** 2;
	}
	return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** The `p`-th percentile (0–100) of an ascending array, linearly interpolated between ranks. */
export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	if (sorted.length === 1) return sorted[0] ?? Number.NaN;
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	const a = sorted[lo] ?? 0;
	const b = sorted[hi] ?? 0;
	return a + (b - a) * (rank - lo);
}

export const mean = (values: readonly number[]): number =>
	values.reduce((a, b) => a + b, 0) / values.length;

/**
 * `resamples` bootstrap means of `values`, ascending. One seeded stream draws every index, resample
 * by resample, so a seed reproduces the same intervals; callers read their percentile indices.
 */
export function bootstrapMeans(
	values: readonly number[],
	seed: string,
	resamples: number
): number[] {
	const rng = createRng(seed);
	const means: number[] = [];
	for (let b = 0; b < resamples; b++) {
		let total = 0;
		for (let i = 0; i < values.length; i++) total += values[rng.int(0, values.length - 1)] ?? 0;
		means.push(total / values.length);
	}
	means.sort((a, b) => a - b);
	return means;
}
