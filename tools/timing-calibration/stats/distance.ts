/**
 * tools/timing-calibration/stats/distance.ts — how far a bot sample is from a human one in the
 * same cell: CRPS, the two-sample KS distance and the one-feature classifier AUC, bundled with
 * both summaries by `compare`.
 */

import { type Obs, type SummaryCI, summariseCI } from "./summary";

/**
 * Mean CRPS (seconds) of the empirical distribution `bot` against each observation of `human`:
 * `E|X − y| − ½ E|X − X'|`, both from sorted samples in O(n log n).
 */
export function crps(bot: readonly number[], human: readonly number[]): number {
	const x = [...bot].sort((a, b) => a - b).map((v) => v / 1000);
	const m = x.length;
	if (m === 0 || human.length === 0) return Number.NaN;
	// ½ E|X − X'| = (1/m²) Σ_i (2i − m + 1) x_i  (0-based, sorted)
	let spread = 0;
	for (let i = 0; i < m; i++) spread += (2 * i - m + 1) * (x[i] ?? 0);
	const halfSpread = spread / (m * m);
	const prefix = new Float64Array(m + 1);
	for (let i = 0; i < m; i++) prefix[i + 1] = (prefix[i] ?? 0) + (x[i] ?? 0);
	let total = 0;
	for (const hv of human) {
		const y = hv / 1000;
		// k = number of x ≤ y
		let lo = 0;
		let hi = m;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((x[mid] ?? 0) <= y) lo = mid + 1;
			else hi = mid;
		}
		const k = lo;
		const below = k * y - (prefix[k] ?? 0);
		const above = (prefix[m] ?? 0) - (prefix[k] ?? 0) - (m - k) * y;
		total += (below + above) / m - halfSpread;
	}
	return total / human.length;
}

/** Two-sample KS distance. */
export function ks(a: readonly number[], b: readonly number[]): number {
	const x = [...a].sort((p, q) => p - q);
	const y = [...b].sort((p, q) => p - q);
	let i = 0;
	let j = 0;
	let d = 0;
	while (i < x.length && j < y.length) {
		const v = Math.min(x[i] ?? 0, y[j] ?? 0);
		while (i < x.length && (x[i] ?? 0) <= v) i++;
		while (j < y.length && (y[j] ?? 0) <= v) j++;
		d = Math.max(d, Math.abs(i / x.length - j / y.length));
	}
	return d;
}

/** P(a > b) + ½ P(a = b) over all pairs (Mann–Whitney), by merging sorted samples. */
export function auc(a: readonly number[], b: readonly number[]): number {
	if (a.length === 0 || b.length === 0) return Number.NaN;
	const x = [...a].sort((p, q) => p - q);
	const y = [...b].sort((p, q) => p - q);
	let wins = 0;
	let jLo = 0;
	let jHi = 0;
	for (const v of x) {
		while (jLo < y.length && (y[jLo] ?? 0) < v) jLo++;
		if (jHi < jLo) jHi = jLo;
		while (jHi < y.length && (y[jHi] ?? 0) <= v) jHi++;
		wins += jLo + 0.5 * (jHi - jLo);
	}
	return wins / (x.length * y.length);
}

/** The comparison of a bot sample against a human sample in one cell. */
export interface Comparison {
	human: SummaryCI;
	bot: SummaryCI;
	crps: number;
	ks: number;
	auc: number;
}

export function compare(human: readonly Obs[], bot: readonly Obs[], resamples = 200): Comparison {
	const h = human.map((o) => o.ms);
	const b = bot.map((o) => o.ms);
	return {
		human: summariseCI(human, resamples, "human"),
		bot: summariseCI(bot, resamples, "bot"),
		crps: crps(b, h),
		ks: ks(b, h),
		auc: auc(b, h),
	};
}
