/**
 * tools/calibration/rating-model/estimate.ts — the rating a set of moves plays at: the pooled
 * maximum-likelihood estimate with its cluster-robust (by game) standard error, the paired
 * difference of two sets over the same games, and a replayed cell's bot-versus-human verdict.
 */

import type { SimRow } from "../sim";
import {
	classTerms,
	covariates,
	etaOf,
	type ModelMove,
	moveClass,
	R_SCALE,
	type RatingModel,
	slopeOf,
	toRating,
} from "./model";

/** Σ log P over `moves` at rating `r`, and its first and second derivatives in r. */
function profile(
	model: RatingModel,
	moves: readonly ModelMove[],
	r: number
): { ll: number; d1: number; d2: number } {
	let ll = 0;
	let d1 = 0;
	let d2 = 0;
	for (const mv of moves) {
		const s = slopeOf(model, mv.x);
		const [l, a, b] = classTerms(model.theta, etaOf(model, mv.x, r), mv.y);
		ll += l;
		d1 += a * s;
		d2 += b * s * s;
	}
	return { ll, d1, d2 };
}

export interface RatingEstimate {
	rating: number;
	/** Cluster-robust (by game) standard error, Elo. */
	se: number;
	n: number;
	clusters: number;
	/** Per-cluster influence on r̂ (for paired differences), r units. */
	influence: Map<string, number>;
}

const R_LO = -2.5;
const R_HI = 3.5;

/** The pooled maximum-likelihood rating of `moves` (bisection on the score; concave). */
export function estimateRating(model: RatingModel, moves: readonly ModelMove[]): RatingEstimate {
	let lo = R_LO;
	let hi = R_HI;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (profile(model, moves, mid).d1 > 0) lo = mid;
		else hi = mid;
	}
	const r = (lo + hi) / 2;
	const { d2 } = profile(model, moves, r);
	const scores = new Map<string, number>();
	for (const mv of moves) {
		const s = slopeOf(model, mv.x);
		const [, a] = classTerms(model.theta, etaOf(model, mv.x, r), mv.y);
		scores.set(mv.cluster, (scores.get(mv.cluster) ?? 0) + a * s);
	}
	const influence = new Map<string, number>();
	let v = 0;
	for (const [c, sc] of scores) {
		const inf = d2 < 0 ? sc / -d2 : 0;
		influence.set(c, inf);
		v += inf * inf;
	}
	const G = scores.size;
	const se = G > 1 ? Math.sqrt((G / (G - 1)) * v) * R_SCALE : Number.POSITIVE_INFINITY;
	return { rating: toRating(r), se, n: moves.length, clusters: G, influence };
}

/** `a − b` for two estimates over the same clusters, with the paired cluster-robust SE. */
export function pairedDifference(
	a: RatingEstimate,
	b: RatingEstimate
): { diff: number; se: number } {
	const clusters = new Set([...a.influence.keys(), ...b.influence.keys()]);
	let v = 0;
	for (const c of clusters) v += ((a.influence.get(c) ?? 0) - (b.influence.get(c) ?? 0)) ** 2;
	const G = clusters.size;
	return {
		diff: a.rating - b.rating,
		se: G > 1 ? Math.sqrt((G / (G - 1)) * v) * R_SCALE : Number.POSITIVE_INFINITY,
	};
}

export interface CellRating {
	/** Mean actual rating of the cell's (game, side) samples. */
	actual: number;
	human: { rating: number; se: number };
	bot: { rating: number; se: number };
	/** Bot − human over the same positions, paired by game. */
	diff: number;
	diffSe: number;
	/** `actual + diff`: the rating the bot plays at, the estimator's bias cancelled. */
	implied: number;
	games: number;
}

/** The humans' and the bot's pooled ratings over one cell's replayed rows, and their paired gap. */
export function cellRating(rows: readonly SimRow[], model: RatingModel): CellRating | null {
	const human: ModelMove[] = [];
	const bot: ModelMove[] = [];
	const ratings = new Map<string, number>();
	for (const r of rows) {
		if (r.human === null) continue;
		const x = covariates(r.shape, r.clockFrac);
		human.push({ x, y: moveClass(r.human), cluster: r.gameKey });
		for (const d of r.draws) bot.push({ x, y: moveClass(d.outcome), cluster: r.gameKey });
		ratings.set(r.gameKey, r.rating);
	}
	if (ratings.size < 5) return null;
	const h = estimateRating(model, human);
	const b = estimateRating(model, bot);
	const { diff, se } = pairedDifference(b, h);
	const actual = [...ratings.values()].reduce((s, v) => s + v, 0) / ratings.size;
	return {
		actual,
		human: { rating: h.rating, se: h.se },
		bot: { rating: b.rating, se: b.se },
		diff,
		diffSe: se,
		implied: actual + diff,
		games: ratings.size,
	};
}
