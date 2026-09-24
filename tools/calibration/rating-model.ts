/**
 * tools/calibration/rating-model.ts — the intrinsic rating model (Maia-free), per time class.
 *
 * A per-move ordered-logit model of move quality given the mover's rating and how hard the
 * position is — the Regan "intrinsic performance rating" idea, fitted to chess.com players:
 *
 *   class y ∈ 0…11: the referee's best move; else the loss between successive `EDGES`
 *   x = [log(1 + near-best moves), second-best loss, decidedness, clock pressure, material on the
 *        board, log legal moves]                                                   (`PositionShape`)
 *   r = (rating − 1800) / 1000
 *   η = w·x + r·(β + v·x)                (error propensity; rating interacts with difficulty)
 *   P(y ≥ k) = σ(η − θ_k), θ_1 < … < θ_11
 *
 * A set of moves' rating is the maximum-likelihood `r` over all of them pooled (the log-likelihood
 * is concave in r), with a cluster-robust sandwich standard error by game. Two sets over the same
 * positions (the bot's draws and the humans' moves) give a **paired** difference whose variance
 * uses the per-game influence of both — the estimator's own bias cancels in it.
 *
 * Replaces the per-game ridge regression of the first verification (held-out R² 0.16–0.36), whose
 * per-game means discarded which positions the errors came from.
 */

import type { MoveOutcome, PositionShape, SimRow } from "./sim";

/**
 * Loss edges between the classes after "the best move": class 1 is loss < EDGES[0], …, the last
 * class loss ≥ the last edge. Fine enough that the model sees the whole loss distribution, not
 * only the board's bands; the bands (0.05 / 0.10 / 0.20) are among the edges.
 */
export const EDGES = [0.005, 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3] as const;
export const CLASSES = EDGES.length + 2;
const THRESHOLDS = CLASSES - 1;
const R_CENTRE = 1800;
const R_SCALE = 1000;
const FEATURES = 6;

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

const sigmoid = (z: number): number =>
	z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

/** log P(y | η) and its first two derivatives in η. */
function classTerms(theta: readonly number[], eta: number, y: number): [number, number, number] {
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

function etaOf(m: RatingModel, x: readonly number[], r: number): number {
	let e = 0;
	let slope = m.beta;
	for (let j = 0; j < FEATURES; j++) {
		e += (m.w[j] as number) * (x[j] as number);
		slope += (m.v[j] as number) * (x[j] as number);
	}
	return e + r * slope;
}

function slopeOf(m: RatingModel, x: readonly number[]): number {
	let slope = m.beta;
	for (let j = 0; j < FEATURES; j++) slope += (m.v[j] as number) * (x[j] as number);
	return slope;
}

export const toR = (rating: number): number => (rating - R_CENTRE) / R_SCALE;
export const toRating = (r: number): number => R_CENTRE + R_SCALE * r;

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
