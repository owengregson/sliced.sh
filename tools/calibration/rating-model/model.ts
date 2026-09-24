/**
 * tools/calibration/rating-model/model.ts — the model's form (see `rating-model.ts`): the move
 * classes, the position covariates, the parameters, the rating scale, and the per-move
 * log-likelihood with its derivatives in η.
 */

import type { MoveOutcome, PositionShape } from "../sim";

/**
 * Loss edges between the classes after "the best move": class 1 is loss < EDGES[0], …, the last
 * class loss ≥ the last edge. Fine enough that the model sees the whole loss distribution, not
 * only the board's bands; the bands (0.05 / 0.10 / 0.20) are among the edges.
 */
export const EDGES = [0.005, 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3] as const;
export const CLASSES = EDGES.length + 2;
export const THRESHOLDS = CLASSES - 1;
const R_CENTRE = 1800;
export const R_SCALE = 1000;
export const FEATURES = 6;

export function moveClass(o: MoveOutcome): number {
	if (o.top1 === 1) return 0;
	for (let i = 0; i < EDGES.length; i++) if (o.winLoss < (EDGES[i] as number)) return i + 1;
	return CLASSES - 1;
}

export function covariates(shape: PositionShape, clockFrac: number): number[] {
	return [
		Math.log1p(shape.nearBest),
		Math.min(0.5, shape.secondLoss),
		shape.decided,
		1 - Math.max(0, Math.min(1, clockFrac)),
		shape.material ?? 1,
		Math.log(Math.max(1, shape.legal ?? 30)) / Math.log(30),
	];
}

/** One judged move for the model. */
export interface ModelMove {
	x: number[];
	y: number;
	/** The cluster (game) it belongs to. */
	cluster: string;
}

export interface RatingModel {
	/** θ_1…θ_(CLASSES−1), increasing. */
	theta: number[];
	w: number[];
	beta: number;
	v: number[];
	trainedOn: number;
	logLik: number;
}

export const sigmoid = (z: number): number =>
	z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

/** log P(y | η) and its first two derivatives in η. */
export function classTerms(
	theta: readonly number[],
	eta: number,
	y: number
): [number, number, number] {
	// S_k = P(y ≥ k) = σ(η − θ_k) for k = 1…5; S_0 = 1, S_6 = 0.
	const S = (k: number): number =>
		k <= 0 ? 1 : k >= CLASSES ? 0 : sigmoid(eta - (theta[k - 1] as number));
	const g = (k: number): number => {
		if (k <= 0 || k >= CLASSES) return 0;
		const s = S(k);
		return s * (1 - s);
	};
	const h = (k: number): number => {
		if (k <= 0 || k >= CLASSES) return 0;
		const s = S(k);
		return s * (1 - s) * (1 - 2 * s);
	};
	const p = Math.max(1e-12, S(y) - S(y + 1));
	const d1 = (g(y) - g(y + 1)) / p;
	const d2 = (h(y) - h(y + 1)) / p - d1 * d1;
	return [Math.log(p), d1, d2];
}

export function etaOf(m: RatingModel, x: readonly number[], r: number): number {
	let e = 0;
	let slope = m.beta;
	for (let j = 0; j < FEATURES; j++) {
		e += (m.w[j] as number) * (x[j] as number);
		slope += (m.v[j] as number) * (x[j] as number);
	}
	return e + r * slope;
}

export function slopeOf(m: RatingModel, x: readonly number[]): number {
	let slope = m.beta;
	for (let j = 0; j < FEATURES; j++) slope += (m.v[j] as number) * (x[j] as number);
	return slope;
}

export const toR = (rating: number): number => (rating - R_CENTRE) / R_SCALE;
export const toRating = (r: number): number => R_CENTRE + R_SCALE * r;
