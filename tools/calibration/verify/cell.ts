/**
 * tools/calibration/verify/cell.ts — one cell's verification (a worker process): the named split's
 * games replayed with the whole table, the error profile overall and per clock quartile, the
 * intrinsic rating verdict, saved as `verify/<label>/cells/<tc>-<bucket>.json`.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
	MAIA_CALIBRATION,
	MAIA_CALIBRATION_IDENTITY,
	type MaiaCalibrationTable,
	type MaiaCalibrationTimeClass,
} from "@core/constants/maia-calibration";
import { maiaCalibrationFor } from "@core/strength/maia-calibration";
import { cellFile, loadCell } from "../cells";
import { VERIFY_DIR } from "../common";
import type { ModelSet } from "../rating-eval";
import { type CellRating, cellRating } from "../rating-model";
import { groupGames, simulate } from "../sim";
import { CLOCK_BINS, type Profile, profiles } from "../stats";
import type { VerifyArgs } from "./args";

async function tableFor(spec: string): Promise<MaiaCalibrationTable> {
	if (spec === "shipped") return MAIA_CALIBRATION;
	if (spec === "identity") return MAIA_CALIBRATION_IDENTITY;
	return (await Bun.file(spec).json()) as MaiaCalibrationTable;
}

export interface CellResult {
	tc: MaiaCalibrationTimeClass;
	bucket: number;
	conditioning: number;
	temperature: number;
	overall: { human: Profile; bot: Profile };
	clock: Array<{ bin: string; human: Profile; bot: Profile }>;
	/** The intrinsic rating model's paired estimate (null when too few games). */
	rating: CellRating | null;
	meanSelfElo: number;
	seconds: number;
}

/** One cell under the table: replayed, profiled overall and per clock quartile, rated. */
export async function verifyCell(args: VerifyArgs): Promise<void> {
	const [tc, bucketText] = (args.cell ?? "").split(":") as [MaiaCalibrationTimeClass, string];
	const bucket = Number(bucketText);
	const started = performance.now();
	const table = await tableFor(args.table);
	const all = await loadCell(cellFile(args.cells, tc, bucket));
	const holdout = all.filter((i) => i.row.split === args.split);
	const games = groupGames(holdout);
	const rows = simulate(games, { targetElo: bucket, table, chains: args.chains, seed: args.seed });
	const overall = profiles(rows);
	const clock = CLOCK_BINS.map(([bin, lo, hi]) => ({
		bin,
		...profiles(rows, (r) => r.clockFrac >= lo && r.clockFrac < hi),
	}));
	const models = (await Bun.file(args.model).json()) as ModelSet;
	const model = models[tc];
	if (!model) throw new Error(`${args.model} has no ${tc} model: run rating-eval.ts --train`);
	const rating = cellRating(rows, model);
	let selfSum = 0;
	let selfN = 0;
	for (const r of rows)
		for (const d of r.draws) {
			selfSum += d.selfElo;
			selfN++;
		}
	const point = maiaCalibrationFor(bucket, tc, table);
	const result: CellResult = {
		tc,
		bucket,
		conditioning: point.conditioningElo,
		temperature: point.temperature,
		overall,
		clock,
		rating,
		meanSelfElo: selfN > 0 ? selfSum / selfN : 0,
		seconds: (performance.now() - started) / 1000,
	};
	const dir = path.join(VERIFY_DIR, args.label, "cells");
	mkdirSync(dir, { recursive: true });
	await Bun.write(path.join(dir, `${tc}-${bucket}.json`), `${JSON.stringify(result)}\n`);
	console.log(`${tc}:${bucket} verified in ${result.seconds.toFixed(0)} s`);
}
