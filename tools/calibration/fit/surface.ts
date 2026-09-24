/**
 * tools/calibration/fit/surface.ts — one cell's objective surface (a worker process): the bot
 * replayed on the cell's positions for each candidate `(Δ, T)` of a flat table, its error profile
 * against the humans' (and, with a rating model, the rating it plays at against the target), and
 * the surface saved as `<out>/cells/<tc>-<bucket>.json`.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
	MAIA_CALIBRATION_TIME_CLASSES,
	type MaiaCalibrationKnot,
	type MaiaCalibrationTable,
	type MaiaCalibrationTimeClass,
} from "@core/constants/maia-calibration";
import { cellFile, loadCell } from "../cells";
import type { ModelSet } from "../rating-eval";
import { cellRating } from "../rating-model";
import { groupGames, simulateMany } from "../sim";
import { FIT_METRICS, objective, type Profile, profiles, zScore } from "../stats";
import type { FitArgs } from "./args";

/** A table flat at `[R, R + Δ, T]` in every class (only the row's own class is ever read). */
export function flatTable(R: number, conditioning: number, T: number): MaiaCalibrationTable {
	const knots: MaiaCalibrationKnot[] = [[R, conditioning, T]];
	return { bullet: knots, blitz: knots, rapid: knots };
}

export interface SurfacePoint {
	offset: number;
	temperature: number;
	objective: number;
	bot: Profile;
	z: Record<string, number>;
	/** The intrinsic rating model's paired estimate: the rating this point plays at. */
	rating?: { implied: number; se: number };
}

export interface CellSurface {
	tc: MaiaCalibrationTimeClass;
	bucket: number;
	rows: number;
	games: number;
	chains: number;
	human: Profile;
	points: SurfacePoint[];
	seconds: number;
}

/** One cell's objective surface: a coarse pass, then the best point's neighbours until it stops moving. */
export async function fitCell(args: FitArgs): Promise<void> {
	const [tc, bucketText] = (args.cell ?? "").split(":");
	const bucket = Number(bucketText);
	if (!MAIA_CALIBRATION_TIME_CLASSES.includes(tc as MaiaCalibrationTimeClass))
		throw new Error(`bad --cell ${args.cell}`);
	const started = performance.now();
	const items = await loadCell(cellFile(args.cells, tc as string, bucket), args.split);
	const games = groupGames(items);
	const model = existsSync(args.model)
		? ((await Bun.file(args.model).json()) as ModelSet)[tc as string]
		: undefined;
	if (!model) console.log(`${args.cell}: no rating model (${args.model}); the rating term is off`);
	let human: Profile | undefined;
	const points: SurfacePoint[] = [];
	const seen = new Set<string>();
	const evaluate = (pairs: ReadonlyArray<readonly [number, number]>): void => {
		const fresh = pairs.filter(([o, t]) => {
			const key = `${o}:${t}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		if (fresh.length === 0) return;
		const results = simulateMany(games, {
			targetElo: bucket,
			tables: fresh.map(([o, t]) => flatTable(bucket, bucket + o, t)),
			chains: args.chains,
			seed: args.seed,
		});
		for (const [j, [offset, temperature]] of fresh.entries()) {
			const p = profiles(results[j] ?? []);
			human ??= p.human;
			const z: Record<string, number> = {};
			for (const m of FIT_METRICS) z[m] = zScore(p.human, p.bot, m);
			// The fifth term: the rating the bot plays at by the Maia-free rating model (paired over
			// these positions), against the cell's target.
			const r = model ? cellRating(results[j] ?? [], model) : null;
			let obj = objective(p.human, p.bot);
			if (r && r.diffSe > 0 && Number.isFinite(r.diffSe)) {
				z.rating = (r.implied - bucket) / r.diffSe;
				obj += z.rating ** 2;
			}
			points.push({
				offset,
				temperature,
				objective: obj,
				bot: p.bot,
				z,
				...(r ? { rating: { implied: r.implied, se: r.diffSe } } : {}),
			});
		}
	};
	const best = (): SurfacePoint => points.reduce((a, b) => (b.objective < a.objective ? b : a));
	const report = (stage: string): void => {
		const b = best();
		console.log(
			`${tc}:${bucket} ${stage}: ${points.length} points, best Δ=${b.offset} T=${b.temperature} obj=${b.objective.toFixed(2)} (${((performance.now() - started) / 1000).toFixed(0)} s)`
		);
	};
	// Coarse: every other grid value in both directions (always including the grid's ends).
	const every2 = <T>(xs: readonly T[]): T[] =>
		xs.filter((_, i) => i % 2 === 0 || i === xs.length - 1);
	const coarse: Array<readonly [number, number]> = [];
	for (const offset of args.refine ? every2(args.offsets) : args.offsets)
		for (const temperature of args.refine ? every2(args.temps) : args.temps)
			coarse.push([offset, temperature]);
	evaluate(coarse);
	report("coarse");
	// Refine: the full grid's neighbours of the best point, until the best stops moving.
	if (args.refine) {
		for (let round = 0; round < 4; round++) {
			const b = best();
			const oi = args.offsets.indexOf(b.offset);
			const ti = args.temps.indexOf(b.temperature);
			const before = points.length;
			const around: Array<readonly [number, number]> = [];
			for (let d = -1; d <= 1; d++)
				for (let e = -1; e <= 1; e++) {
					const o = args.offsets[oi + d];
					const t = args.temps[ti + e];
					if (o !== undefined && t !== undefined) around.push([o, t]);
				}
			evaluate(around);
			report(`refine ${round + 1}`);
			if (points.length === before || best() === b) break;
		}
	}
	if (!human) throw new Error(`${args.cell}: no rows`);
	const surface: CellSurface = {
		tc: tc as MaiaCalibrationTimeClass,
		bucket,
		rows: items.length,
		games: games.length,
		chains: args.chains,
		human,
		points,
		seconds: (performance.now() - started) / 1000,
	};
	mkdirSync(path.join(args.out, "cells"), { recursive: true });
	await Bun.write(
		path.join(args.out, "cells", `${tc}-${bucket}.json`),
		`${JSON.stringify(surface)}\n`
	);
}
