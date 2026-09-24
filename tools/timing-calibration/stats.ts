/**
 * tools/timing-calibration/stats.ts — think-time distribution statistics with honest uncertainty.
 *
 * Per cell (time-control group × rating band × situation):
 *
 *   q10 … q90   think-time quantiles (s), linearly interpolated
 *   premove     P(think ≤ `PREMOVE_MAX_MS`) — chess.com's 0.1 s premove tick
 *   sub1        P(think < 1 s)
 *   crps        mean CRPS of the bot's empirical distribution against each human think (s)
 *   ks          two-sample Kolmogorov–Smirnov distance
 *   auc         P(bot think > human think) + ½ P(tie): the AUC of the best real-vs-bot classifier
 *               that sees one think time (0.5 = indistinguishable; reported as |AUC − 0.5| too)
 *
 * Moves of one player are not independent (pace is a personal trait, and one prolific account can
 * dominate a bucket), so intervals are **cluster bootstrap by player**: players are resampled with
 * replacement and every statistic is recomputed; the 2.5/97.5 percentiles are the 95 % interval.
 * The bot's draws are clustered by the human side they replay.
 */

import { createRng } from "@core/rng";
import { PREMOVE_MAX_MS } from "./common";

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

/**
 * Deterministic per-player cap: at most `cap` game-sides per (player, time class), chosen by a
 * hash of the game id so the same sides are kept on every run.
 */
export function capSides<T extends { player: string; tc: string; gameId: string }>(
	rows: readonly T[],
	cap: number
): T[] {
	const sides = new Map<string, Set<string>>();
	for (const r of rows) {
		const key = `${r.player}\t${r.tc}`;
		let s = sides.get(key);
		if (!s) {
			s = new Set();
			sides.set(key, s);
		}
		s.add(r.gameId);
	}
	const keep = new Set<string>();
	for (const [key, games] of sides) {
		const ordered = [...games].sort((a, b) => hash32(a) - hash32(b) || a.localeCompare(b));
		for (const g of ordered.slice(0, cap)) keep.add(`${key}\t${g}`);
	}
	return rows.filter((r) => keep.has(`${r.player}\t${r.tc}\t${r.gameId}`));
}

/** FNV-1a. */
export function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}
