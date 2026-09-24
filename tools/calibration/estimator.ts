/**
 * tools/calibration/estimator.ts — an intrinsic rating estimator that knows nothing about Maia.
 *
 * Trained on the **fit** split's human games only: per (game, side) the move-quality features
 * below → the side's chess.com rating, ridge regression per time class on standardised features
 * (linear and squared terms). It is the independent check of the calibration: the verification
 * applies it to the bot's moves over the held-out games' positions and to the humans' own moves
 * over the same positions, so position difficulty cancels in the paired difference, and converts
 * that difference to Elo through the estimator's own slope on held-out humans.
 *
 * Features per pseudo-game (≥ `MIN_MOVES` judged moves): mean expected-points loss, the
 * inaccuracy / mistake / blunder rates, the referee-best rate, log(1 + ACPL).
 */

import type { MoveOutcome } from "./sim";
import { METRICS, metricValues } from "./stats";

export const MIN_MOVES = 8;
const RIDGE = 1e-3;

export function features(moves: readonly MoveOutcome[]): number[] | null {
	if (moves.length < MIN_MOVES) return null;
	const sums: Record<string, number> = {};
	for (const m of METRICS) sums[m] = 0;
	for (const o of moves) {
		const v = metricValues(o);
		for (const m of METRICS) sums[m] = (sums[m] ?? 0) + v[m];
	}
	const n = moves.length;
	const mean = (m: string) => (sums[m] ?? 0) / n;
	const base = [
		mean("epl"),
		mean("inacc"),
		mean("mistake"),
		mean("blunder"),
		mean("top1"),
		Math.log1p(mean("acpl")),
	];
	return [...base, ...base.map((x) => x * x)];
}

export interface Model {
	mu: number[];
	sd: number[];
	weights: number[];
	intercept: number;
	trainedOn: number;
	/** Residual SD on the training games. */
	residualSd: number;
}

/** Solve `A x = b` (small, symmetric positive definite) by Gaussian elimination with pivoting. */
function solve(A: number[][], b: number[]): number[] {
	const n = b.length;
	const M = A.map((row, i) => [...row, b[i] as number]);
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs((M[r] as number[])[c] as number) > Math.abs((M[piv] as number[])[c] as number))
				piv = r;
		[M[c], M[piv]] = [M[piv] as number[], M[c] as number[]];
		const pr = M[c] as number[];
		const d = pr[c] as number;
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const row = M[r] as number[];
			const f = (row[c] as number) / d;
			for (let k = c; k <= n; k++) row[k] = (row[k] as number) - f * (pr[k] as number);
		}
	}
	return M.map((row, i) => (row[n] as number) / (row[i] as number));
}

export function train(xs: readonly number[][], ys: readonly number[]): Model {
	const n = xs.length;
	const d = xs[0]?.length ?? 0;
	if (n <= d) throw new Error(`estimator: ${n} games for ${d} features`);
	const mu = Array.from({ length: d }, (_, j) => xs.reduce((s, x) => s + (x[j] as number), 0) / n);
	const sd = Array.from({ length: d }, (_, j) => {
		const v = xs.reduce((s, x) => s + ((x[j] as number) - (mu[j] as number)) ** 2, 0) / n;
		return Math.sqrt(v) || 1;
	});
	const z = xs.map((x) => x.map((v, j) => (v - (mu[j] as number)) / (sd[j] as number)));
	const yMean = ys.reduce((s, y) => s + y, 0) / n;
	const A = Array.from({ length: d }, (_, i) =>
		Array.from(
			{ length: d },
			(_, j) =>
				z.reduce((s, r) => s + (r[i] as number) * (r[j] as number), 0) + (i === j ? RIDGE * n : 0)
		)
	);
	const b = Array.from({ length: d }, (_, i) =>
		z.reduce((s, r, k) => s + (r[i] as number) * ((ys[k] as number) - yMean), 0)
	);
	const weights = solve(A, b);
	const model: Model = { mu, sd, weights, intercept: yMean, trainedOn: n, residualSd: 0 };
	let ss = 0;
	for (let k = 0; k < n; k++) ss += (predict(model, xs[k] as number[]) - (ys[k] as number)) ** 2;
	model.residualSd = Math.sqrt(ss / n);
	return model;
}

export function predict(model: Model, x: readonly number[]): number {
	let y = model.intercept;
	for (let j = 0; j < x.length; j++)
		y +=
			(model.weights[j] as number) *
			(((x[j] as number) - (model.mu[j] as number)) / (model.sd[j] as number));
	return y;
}

/** Ordinary least-squares slope and intercept of `ys` on `xs`. */
export function linearFit(xs: readonly number[], ys: readonly number[]): { a: number; b: number } {
	const n = xs.length;
	const mx = xs.reduce((s, v) => s + v, 0) / n;
	const my = ys.reduce((s, v) => s + v, 0) / n;
	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
		sxx += ((xs[i] as number) - mx) ** 2;
	}
	const b = sxx > 0 ? sxy / sxx : 0;
	return { a: my - b * mx, b };
}
