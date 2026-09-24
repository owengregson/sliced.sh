/**
 * tools/calibration/rating-eval/map-rating.ts — one game's rating by maximum a posteriori: the
 * model's log-likelihood with a Gaussian prior on the rating, maximised by bisection on a
 * numerical derivative. The per-game accuracy check of `evaluate.ts`.
 */

import { CLASSES, type ModelMove, type RatingModel, toR, toRating } from "../rating-model";

/** MAP rating of one game's moves with a N(prior, priorSd) prior on the rating. */
export function mapRating(
	model: RatingModel,
	moves: readonly ModelMove[],
	prior: number,
	priorSd: number
) {
	// Augment the concave log-likelihood with the Gaussian prior; bisection on the derivative.
	const r0 = toR(prior);
	const s0 = priorSd / 1000;
	let lo = -2.5;
	let hi = 3.5;
	const score = (r: number): number => {
		const e = estimateRatingScore(model, moves, r);
		return e - (r - r0) / (s0 * s0);
	};
	for (let i = 0; i < 50; i++) {
		const mid = (lo + hi) / 2;
		if (score(mid) > 0) lo = mid;
		else hi = mid;
	}
	return toRating((lo + hi) / 2);
}

/** d/dr Σ log P at `r` (delegates to the pooled estimator's internals through a one-cluster fit). */
function estimateRatingScore(model: RatingModel, moves: readonly ModelMove[], r: number): number {
	const h = 1e-4;
	const ll = (rr: number): number => {
		let s = 0;
		for (const mv of moves) s += logP(model, mv, rr);
		return s;
	};
	return (ll(r + h) - ll(r - h)) / (2 * h);
}

function logP(model: RatingModel, mv: ModelMove, r: number): number {
	let e = 0;
	let slope = model.beta;
	for (let j = 0; j < mv.x.length; j++) {
		e += (model.w[j] as number) * (mv.x[j] as number);
		slope += (model.v[j] as number) * (mv.x[j] as number);
	}
	const eta = e + r * slope;
	const sig = (z: number): number => 1 / (1 + Math.exp(-z));
	const S = (k: number): number =>
		k <= 0 ? 1 : k >= CLASSES ? 0 : sig(eta - (model.theta[k - 1] as number));
	return Math.log(Math.max(1e-12, S(mv.y) - S(mv.y + 1)));
}
