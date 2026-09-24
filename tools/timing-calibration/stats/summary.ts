/**
 * tools/timing-calibration/stats/summary.ts — one sample's think-time summary (quantiles in
 * seconds, the premove and sub-second shares, the mean) and its player-cluster bootstrap 95 %
 * intervals: players are resampled with replacement and every statistic is recomputed.
 */

import { createRng } from "@core/rng";
import { PREMOVE_MAX_MS } from "../common/bands";

/** One observation: think (ms) and the cluster (player) it belongs to. */
export interface Obs {
	ms: number;
	cluster: string;
}

export const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9] as const;

export interface Summary {
	n: number;
	clusters: number;
	/** Quantiles in seconds, in `QUANTILES` order. */
	q: number[];
	premove: number;
	sub1: number;
	mean: number;
}

export function quantileSorted(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const rank = p * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	const a = sorted[lo] ?? 0;
	const b = sorted[hi] ?? 0;
	return a + (b - a) * (rank - lo);
}

export function summarise(values: readonly number[], clusters = 0): Summary {
	const s = [...values].sort((a, b) => a - b);
	let premove = 0;
	let sub1 = 0;
	let total = 0;
	for (const v of s) {
		if (v <= PREMOVE_MAX_MS) premove++;
		if (v < 1000) sub1++;
		total += v;
	}
	const n = s.length;
	return {
		n,
		clusters,
		q: QUANTILES.map((p) => quantileSorted(s, p) / 1000),
		premove: n ? premove / n : Number.NaN,
		sub1: n ? sub1 / n : Number.NaN,
		mean: n ? total / n / 1000 : Number.NaN,
	};
}

/** Group values by cluster. */
export function byCluster(obs: readonly Obs[]): Map<string, number[]> {
	const m = new Map<string, number[]>();
	for (const o of obs) {
		const list = m.get(o.cluster);
		if (list) list.push(o.ms);
		else m.set(o.cluster, [o.ms]);
	}
	return m;
}

export interface Interval {
	lo: number;
	hi: number;
}

export interface SummaryCI extends Summary {
	ci: { q: Interval[]; premove: Interval; sub1: Interval };
}

/** `summarise` plus a player-cluster bootstrap 95 % interval of every statistic. */
export function summariseCI(
	obs: readonly Obs[],
	resamples = 200,
	seed = "timing-calib"
): SummaryCI {
	return summariseGroups([...byCluster(obs).values()], resamples, seed);
}

/**
 * The same from values already grouped by cluster. The bootstrap is capped at about 2·10⁷ resampled
 * values per cell (fewer resamples for huge cells) so a crawl-sized cell stays tractable.
 */
export function summariseGroups(
	groups: readonly (readonly number[])[],
	requested = 200,
	seed = "timing-calib"
): SummaryCI {
	const all: number[] = [];
	for (const g of groups) for (const v of g) all.push(v);
	const base = summarise(all, groups.length);
	const resamples = Math.min(requested, Math.max(20, Math.floor(2e7 / Math.max(1, all.length))));
	const rng = createRng(seed);
	const qs: number[][] = QUANTILES.map(() => []);
	const pre: number[] = [];
	const s1: number[] = [];
	if (groups.length >= 2) {
		for (let b = 0; b < resamples; b++) {
			const vals: number[] = [];
			for (let i = 0; i < groups.length; i++) {
				const g = groups[rng.int(0, groups.length - 1)] ?? [];
				for (const v of g) vals.push(v);
			}
			const s = summarise(vals);
			s.q.forEach((v, i) => {
				qs[i]?.push(v);
			});
			pre.push(s.premove);
			s1.push(s.sub1);
		}
	}
	const iv = (xs: number[]): Interval => {
		if (xs.length === 0) return { lo: Number.NaN, hi: Number.NaN };
		const s = [...xs].sort((a, b) => a - b);
		return { lo: quantileSorted(s, 0.025), hi: quantileSorted(s, 0.975) };
	};
	return { ...base, ci: { q: qs.map(iv), premove: iv(pre), sub1: iv(s1) } };
}
