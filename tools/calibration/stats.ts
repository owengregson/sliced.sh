/**
 * tools/calibration/stats.ts — the error profile of a set of moves, with honest uncertainty.
 *
 * Metrics (per move; the thresholds are the board ratings' published bands, `MOVE_CLASSIFICATION`, so "blunder" means what
 * the owner sees on the board):
 *
 *   epl        mean win-probability loss (chess.com's expected-points loss)
 *   inacc      P(loss ≥ BANDS.inaccuracyLoss)   — inaccuracy or worse
 *   mistake    P(loss ≥ BANDS.mistakeLoss)      — mistake or worse
 *   blunder    P(loss ≥ BANDS.blunderLoss)      — blunder
 *   acpl       mean centipawn loss (capped at `CP_LOSS_CAP`)
 *   top1       P(the referee's best move)
 *
 * Moves of one game are not independent (a player's form, the position's difficulty), so every
 * standard error is **cluster-robust by game**: the ratio estimator `Σy / Σn` over games with
 * `SE² = G/(G−1) · Σ_g (y_g − r·n_g)² / (Σ n)²`. The bot's numbers pool its chains within a game
 * into the same cluster.
 */

import { MOVE_CLASSIFICATION as BANDS } from "@core/constants/review";
import type { MoveOutcome, SimRow } from "./sim";

export const METRICS = ["epl", "inacc", "mistake", "blunder", "acpl", "top1"] as const;
export type Metric = (typeof METRICS)[number];

/** The metrics the fit matches (ACPL and top-1 are reported, not fitted: see `fit.ts`). */
export const FIT_METRICS: readonly Metric[] = ["epl", "inacc", "mistake", "blunder"];

export function metricValues(o: MoveOutcome): Record<Metric, number> {
	return {
		epl: o.winLoss,
		inacc: o.winLoss >= BANDS.inaccuracyLoss ? 1 : 0,
		mistake: o.winLoss >= BANDS.mistakeLoss ? 1 : 0,
		blunder: o.winLoss >= BANDS.blunderLoss ? 1 : 0,
		acpl: o.cpLoss,
		top1: o.top1,
	};
}

export interface Estimate {
	mean: number;
	se: number;
	/** Moves (bot: draws) behind the estimate. */
	n: number;
	/** Games (clusters). */
	games: number;
}

export type Profile = Record<Metric, Estimate>;

/** Accumulates per-cluster sums, then the cluster-robust ratio estimate of every metric. */
export class ProfileBuilder {
	private readonly clusters = new Map<string, { n: number; sums: Record<Metric, number> }>();

	add(cluster: string, o: MoveOutcome): void {
		let c = this.clusters.get(cluster);
		if (!c) {
			c = { n: 0, sums: { epl: 0, inacc: 0, mistake: 0, blunder: 0, acpl: 0, top1: 0 } };
			this.clusters.set(cluster, c);
		}
		c.n++;
		const v = metricValues(o);
		for (const m of METRICS) c.sums[m] += v[m];
	}

	get size(): number {
		let n = 0;
		for (const c of this.clusters.values()) n += c.n;
		return n;
	}

	build(): Profile {
		const G = this.clusters.size;
		let N = 0;
		for (const c of this.clusters.values()) N += c.n;
		const out = {} as Profile;
		for (const m of METRICS) {
			let Y = 0;
			for (const c of this.clusters.values()) Y += c.sums[m];
			const r = N > 0 ? Y / N : 0;
			let ss = 0;
			for (const c of this.clusters.values()) ss += (c.sums[m] - r * c.n) ** 2;
			const se = G > 1 && N > 0 ? Math.sqrt((G / (G - 1)) * ss) / N : Number.POSITIVE_INFINITY;
			out[m] = { mean: r, se, n: N, games: G };
		}
		return out;
	}
}

export type RowFilter = (row: SimRow) => boolean;

/** The human and bot profiles of `rows`, restricted to rows with a scored human move. */
export function profiles(
	rows: readonly SimRow[],
	filter: RowFilter = () => true
): { human: Profile; bot: Profile } {
	const human = new ProfileBuilder();
	const bot = new ProfileBuilder();
	for (const r of rows) {
		if (r.human === null || !filter(r)) continue;
		human.add(r.gameKey, r.human);
		for (const d of r.draws) bot.add(r.gameKey, d.outcome);
	}
	return { human: human.build(), bot: bot.build() };
}

/**
 * The fit's distance: Σ over `FIT_METRICS` of the squared standardised difference between bot and
 * human, `((bot − human) / √(SE_h² + SE_b²))²`. With the uncertainty in the denominator a cell's
 * objective is χ²-like: ≈ |FIT_METRICS| when the bot is statistically indistinguishable.
 */
export function objective(human: Profile, bot: Profile, metrics = FIT_METRICS): number {
	let sum = 0;
	for (const m of metrics) {
		const se = Math.sqrt(human[m].se ** 2 + bot[m].se ** 2);
		if (!(se > 0) || !Number.isFinite(se)) continue;
		sum += ((bot[m].mean - human[m].mean) / se) ** 2;
	}
	return sum;
}

/** Signed z of bot − human for one metric. */
export function zScore(human: Profile, bot: Profile, m: Metric): number {
	const se = Math.sqrt(human[m].se ** 2 + bot[m].se ** 2);
	return se > 0 && Number.isFinite(se) ? (bot[m].mean - human[m].mean) / se : 0;
}

/** Clock quartiles by the mover's clock over the base clock, lowest clock first. */
export const CLOCK_BINS: ReadonlyArray<readonly [string, number, number]> = [
	["clock < 25%", 0, 0.25],
	["25–50%", 0.25, 0.5],
	["50–75%", 0.5, 0.75],
	["≥ 75%", 0.75, 1.01],
];
