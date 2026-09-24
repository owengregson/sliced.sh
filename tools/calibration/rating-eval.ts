/**
 * tools/calibration/rating-eval.ts — train the intrinsic rating model and measure its accuracy.
 *
 *   bun tools/calibration/rating-eval.ts --extract   # cells → data/calibration/moves.jsonl
 *   bun tools/calibration/rating-eval.ts --train [--train-split fit|holdout|all] [--model-out F]
 *       # the split's humans → F (default data/calibration/rating-model.json), and its accuracy on
 *       # the other split's humans → F with `-eval.md` (in-sample when trained on all)
 *
 * Accuracy is measured on the holdout players only, two ways:
 *   - **cell recovery**: each time class × bucket's pooled estimate from its humans' moves against
 *     their mean actual rating (bias, RMSE, and whether the 95 % interval covers it);
 *   - **per game**: a MAP estimate per (game, side) with a weak prior at the class mean, and the R²
 *     of actual rating on it — directly comparable with the first estimator's per-game R².
 */

import "../lib/defines";
import { readdirSync } from "node:fs";
import path from "node:path";
import { MAIA_CALIBRATION_TIME_CLASSES } from "@core/constants/maia-calibration";
import { DATA_DIR } from "./common";
import { jsonlLines } from "./frames";
import {
	CLASSES,
	covariates,
	estimateRating,
	type ModelMove,
	moveClass,
	type RatingModel,
	toR,
	toRating,
	trainModel,
} from "./rating-model";
import { CELLS_DIR } from "./shard";
import { type CellItem, judgeFor, type PositionShape, positionFacts } from "./sim";

export const MOVES_FILE = path.join(DATA_DIR, "moves.jsonl");
export const MODEL_FILE = path.join(DATA_DIR, "rating-model.json");

/** One human move as the model reads it. */
export interface HumanMove {
	tc: string;
	bucket: number;
	split: string;
	rating: number;
	game: string;
	clockFrac: number;
	shape: PositionShape;
	y: number;
}

export type ModelSet = Record<string, RatingModel>;

async function extract(): Promise<void> {
	const writer = Bun.file(MOVES_FILE).writer();
	let n = 0;
	for (const f of readdirSync(CELLS_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()) {
		for await (const line of jsonlLines(path.join(CELLS_DIR, f))) {
			const it = JSON.parse(line) as CellItem;
			const judge = judgeFor(it.frame);
			Object.assign(judge.shape, positionFacts(it.row.fen));
			const human = judge.outcome(it.row.humanMove);
			if (human === null) continue;
			const row = it.row;
			const move: HumanMove = {
				tc: row.tc,
				bucket: row.bucket,
				split: row.split ?? "fit",
				rating: row.selfElo,
				game: `${row.gameId ?? row.id}:${row.color ?? ""}`,
				clockFrac: (row.baseMs ?? 0) > 0 ? row.clockMs / (row.baseMs ?? 1) : 1,
				shape: judge.shape,
				y: moveClass(human),
			};
			writer.write(`${JSON.stringify(move)}\n`);
			n++;
		}
		console.log(`${f}: ${n} moves so far`);
	}
	await writer.end();
	console.log(`wrote ${n} moves → ${MOVES_FILE}`);
}

export async function loadModels(file = MODEL_FILE): Promise<ModelSet> {
	return (await Bun.file(file).json()) as ModelSet;
}

const toModelMove = (m: HumanMove): ModelMove => ({
	x: covariates(m.shape, m.clockFrac),
	y: m.y,
	cluster: m.game,
});

/** MAP rating of one game's moves with a N(prior, priorSd) prior on the rating. */
function mapRating(
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

async function trainAndEvaluate(trainSplit: string, modelOut: string): Promise<void> {
	const all: HumanMove[] = [];
	for await (const line of jsonlLines(MOVES_FILE)) all.push(JSON.parse(line) as HumanMove);
	const models: ModelSet = {};
	const out: string[] = [
		"# Intrinsic rating model — accuracy on held-out chess.com players",
		"",
		"Per-move ordered logit (`rating-model.ts`), trained on the fit split; everything below is the holdout split.",
		"",
	];
	for (const tc of MAIA_CALIBRATION_TIME_CLASSES) {
		const fit = all.filter((m) => m.tc === tc && (trainSplit === "all" || m.split === trainSplit));
		// Evaluated on the players it was not trained on (in-sample when trained on all).
		const hold = all.filter((m) => m.tc === tc && (trainSplit === "all" || m.split !== trainSplit));
		const started = performance.now();
		const model = trainModel(fit.map((m) => ({ ...toModelMove(m), rating: m.rating })));
		models[tc] = model;
		console.log(
			`${tc}: trained on ${fit.length} moves in ${((performance.now() - started) / 1000).toFixed(0)} s, β=${model.beta.toFixed(3)}`
		);
		// Cell recovery.
		out.push(
			`## ${tc}`,
			"",
			"| bucket | games | moves | actual (mean) | estimate ± 1.96 SE | error | covered |",
			"|---:|---:|---:|---:|---|---:|:-:|"
		);
		const errors: number[] = [];
		let covered = 0;
		let cells = 0;
		for (const bucket of [...new Set(hold.map((m) => m.bucket))].sort((a, b) => a - b)) {
			const ms = hold.filter((m) => m.bucket === bucket);
			const games = new Map<string, number>();
			for (const m of ms) games.set(m.game, m.rating);
			if (games.size < 10) continue;
			const actual = [...games.values()].reduce((s, v) => s + v, 0) / games.size;
			const est = estimateRating(model, ms.map(toModelMove));
			const err = est.rating - actual;
			const ok = Math.abs(err) <= 1.96 * est.se;
			errors.push(err);
			cells++;
			if (ok) covered++;
			out.push(
				`| ${bucket} | ${games.size} | ${ms.length} | ${Math.round(actual)} | ${Math.round(est.rating)} ± ${Math.round(1.96 * est.se)} | ${err >= 0 ? "+" : ""}${Math.round(err)} | ${ok ? "✓" : "✗"} |`
			);
		}
		const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / Math.max(1, errors.length));
		const bias = errors.reduce((s, e) => s + e, 0) / Math.max(1, errors.length);
		// Per-game MAP and R².
		const byGame = new Map<string, HumanMove[]>();
		for (const m of hold) {
			const list = byGame.get(m.game) ?? [];
			list.push(m);
			byGame.set(m.game, list);
		}
		const prior = fit.reduce((s, m) => s + m.rating, 0) / fit.length;
		const priorSd = Math.sqrt(fit.reduce((s, m) => s + (m.rating - prior) ** 2, 0) / fit.length);
		const xs: number[] = [];
		const ys: number[] = [];
		for (const list of byGame.values()) {
			if (list.length < 8) continue;
			xs.push(mapRating(model, list.map(toModelMove), prior, priorSd));
			ys.push(list[0]?.rating ?? prior);
		}
		const my = ys.reduce((s, v) => s + v, 0) / ys.length;
		const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
		let sxy = 0;
		let sxx = 0;
		let syy = 0;
		for (let i = 0; i < xs.length; i++) {
			sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
			sxx += ((xs[i] as number) - mx) ** 2;
			syy += ((ys[i] as number) - my) ** 2;
		}
		const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
		out.push(
			"",
			`Cell recovery: bias ${bias >= 0 ? "+" : ""}${Math.round(bias)}, RMSE ${Math.round(rmse)} Elo, 95 % interval covers the actual mean in ${covered}/${cells} cells. Per game (${xs.length} games, MAP with a N(${Math.round(prior)}, ${Math.round(priorSd)}) prior): R² ${r2.toFixed(2)}.`,
			""
		);
	}
	await Bun.write(modelOut, `${JSON.stringify(models, null, 1)}\n`);
	await Bun.write(modelOut.replace(/\.json$/, "-eval.md"), out.join("\n"));
	console.log(out.join("\n"));
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("--extract")) await extract();
	const opt = (name: string, fallback: string): string => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : fallback;
	};
	if (argv.includes("--train"))
		await trainAndEvaluate(opt("--train-split", "fit"), opt("--model-out", MODEL_FILE));
}

if (import.meta.main) await main();
