/**
 * tools/calibration/rating-eval/evaluate.ts — train one model per time class on a split's humans
 * and measure it on the other split's (in-sample when trained on all): cell recovery (bias, RMSE,
 * interval coverage) and per-game MAP R². Writes the model set and its `-eval.md`.
 */

import { MAIA_CALIBRATION_TIME_CLASSES } from "@core/constants/maia-calibration";
import { jsonlLines } from "../../lib/jsonl";
import { estimateRating, trainModel } from "../rating-model";
import { mapRating } from "./map-rating";
import { type HumanMove, MOVES_FILE, type ModelSet, toModelMove } from "./moves";

export async function trainAndEvaluate(trainSplit: string, modelOut: string): Promise<void> {
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
