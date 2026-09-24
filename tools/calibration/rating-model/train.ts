/**
 * tools/calibration/rating-model/train.ts — fitting the model to rated moves: full-batch Adam on the
 * mean log-likelihood, θ kept increasing by its reparametrisation. Deterministic.
 */

import { CLASSES, etaOf, FEATURES, type RatingModel, sigmoid, THRESHOLDS, toR } from "./model";

/**
 * Fit the model by full-batch Adam on the mean log-likelihood. θ is kept increasing through
 * θ_1 + Σ exp(δ). Deterministic.
 */
export function trainModel(
	moves: ReadonlyArray<{ x: number[]; y: number; rating: number }>,
	iterations = 1500
): RatingModel {
	const n = moves.length;
	if (n < 200) throw new Error(`rating model: ${n} moves is too few`);
	// params: [θ1, δ2..δ_T, w, β, v]
	const T = THRESHOLDS;
	const P = T + FEATURES + 1 + FEATURES;
	const params = new Float64Array(P);
	for (let k = 1; k < T; k++) params[k] = -1;
	const unpack = (): RatingModel => {
		const theta = [params[0] as number];
		for (let k = 1; k < T; k++) theta.push((theta[k - 1] as number) + Math.exp(params[k] as number));
		return {
			theta,
			w: Array.from(params.slice(T, T + FEATURES)),
			beta: params[T + FEATURES] as number,
			v: Array.from(params.slice(T + 1 + FEATURES, T + 1 + 2 * FEATURES)),
			trainedOn: n,
			logLik: 0,
		};
	};
	const m1 = new Float64Array(P);
	const m2 = new Float64Array(P);
	const lr = 0.05;
	let logLik = 0;
	for (let it = 1; it <= iterations; it++) {
		const m = unpack();
		const grad = new Float64Array(P);
		logLik = 0;
		for (const mv of moves) {
			const r = toR(mv.rating);
			const eta = etaOf(m, mv.x, r);
			// Per-threshold derivatives: d log p / d θ_k.
			const S = (k: number): number =>
				k <= 0 ? 1 : k >= CLASSES ? 0 : sigmoid(eta - (m.theta[k - 1] as number));
			const y = mv.y;
			const p = Math.max(1e-12, S(y) - S(y + 1));
			logLik += Math.log(p);
			const gy = y >= 1 && y < CLASSES ? S(y) * (1 - S(y)) : 0;
			const gy1 = y + 1 >= 1 && y + 1 < CLASSES ? S(y + 1) * (1 - S(y + 1)) : 0;
			const dEta = (gy - gy1) / p;
			// θ_k enters with sign −: d/dθ_y = −g_y/p, d/dθ_{y+1} = +g_{y+1}/p.
			const dTheta = new Array<number>(T).fill(0);
			if (y >= 1) dTheta[y - 1] = -gy / p;
			if (y + 1 < CLASSES) dTheta[y] = (dTheta[y] ?? 0) + gy1 / p;
			// chain through the reparametrisation: θ_j = θ1 + Σ_{k≤j} exp(δ_k)
			for (let j = 0; j < T; j++) {
				const dj = dTheta[j] as number;
				if (dj === 0) continue;
				grad[0] = (grad[0] as number) + dj;
				for (let k = 1; k <= j; k++) grad[k] = (grad[k] as number) + dj * Math.exp(params[k] as number);
			}
			for (let f = 0; f < FEATURES; f++) {
				const xf = mv.x[f] as number;
				grad[T + f] = (grad[T + f] as number) + dEta * xf;
				grad[T + 1 + FEATURES + f] = (grad[T + 1 + FEATURES + f] as number) + dEta * r * xf;
			}
			grad[T + FEATURES] = (grad[T + FEATURES] as number) + dEta * r;
		}
		// Adam ascent on the mean log-likelihood.
		for (let j = 0; j < P; j++) {
			const g = (grad[j] as number) / n;
			m1[j] = 0.9 * (m1[j] as number) + 0.1 * g;
			m2[j] = 0.999 * (m2[j] as number) + 0.001 * g * g;
			const mh = (m1[j] as number) / (1 - 0.9 ** it);
			const vh = (m2[j] as number) / (1 - 0.999 ** it);
			params[j] = (params[j] as number) + (lr * mh) / (Math.sqrt(vh) + 1e-8);
		}
	}
	const model = unpack();
	model.logLik = logLik;
	return model;
}
