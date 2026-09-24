/**
 * tools/calibration/requests.ts — the Maia grid each corpus row needs (`maia-batch.ts` input).
 *
 * The fit sweeps the conditioning rating over `R + Δ` (Δ in `fit.ts --offsets`) and the pipeline
 * then lowers it by the context terms (clock/think up to `MAIA.context.maxPenalty`, opponent
 * pressure up to `raceEloReduction`), so a row of bucket R needs Maia at every grid rating in
 * `[R − below, R + above]` (bullet deeper, `belowByTc`), clamped to the model's conditioning
 * range. The simulation interpolates log-linearly between grid points (`PolicyGrid`) and clamps
 * outside the grid.
 *
 *   bun tools/calibration/requests.ts [--corpus F] [--out F] [--step 100] [--below 900] [--above 1000]
 */

import "../lib/defines";
import path from "node:path";
import { MAIA } from "@core/constants/maia";
import { DATA_DIR } from "./common";
import { type CalibrationRow, jsonlLines } from "./frames";

export interface GridSpec {
	step: number;
	below: number;
	above: number;
	/**
	 * A deeper `below` per time class. Bullet: the first fit bound at Δ = −600 (humans' bullet
	 * errors are far above Maia's at the target), so the fit sweeps to Δ = −1000 there and its rows
	 * need the grid 400 lower.
	 */
	belowByTc?: Readonly<Record<string, number>>;
}

export const DEFAULT_GRID: GridSpec = {
	step: 100,
	below: 900,
	above: 1000,
	belowByTc: { bullet: 1300 },
};

/** The grid ratings for bucket `R`: multiples of `step` within `[R − below, R + above]`, clamped. */
export function gridFor(R: number, spec: GridSpec = DEFAULT_GRID, tc?: string): number[] {
	const below = (tc === undefined ? undefined : spec.belowByTc?.[tc]) ?? spec.below;
	const lo = Math.max(MAIA.context.eloFloor, R - below);
	const hi = Math.min(MAIA.conditioningEloMax, R + spec.above);
	const out: number[] = [];
	for (let e = Math.ceil(lo / spec.step) * spec.step; e <= hi; e += spec.step) out.push(e);
	if (out[0] !== lo) out.unshift(lo);
	if (out[out.length - 1] !== hi) out.push(hi);
	return out;
}

function arg(argv: string[], name: string, fallback: string): string {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const corpus = arg(argv, "--corpus", path.join(DATA_DIR, "corpus.jsonl"));
	const out = arg(argv, "--out", path.join(DATA_DIR, "requests.jsonl"));
	const spec: GridSpec = {
		step: Number(arg(argv, "--step", String(DEFAULT_GRID.step))),
		below: Number(arg(argv, "--below", String(DEFAULT_GRID.below))),
		above: Number(arg(argv, "--above", String(DEFAULT_GRID.above))),
	};
	const writer = Bun.file(out).writer();
	let rows = 0;
	let queries = 0;
	for await (const line of jsonlLines(corpus)) {
		const row = JSON.parse(line) as CalibrationRow;
		const selfElos = gridFor(row.bucket, { ...DEFAULT_GRID, ...spec }, row.tc);
		writer.write(
			`${JSON.stringify({ id: row.id, historyFens: row.historyFens, oppoElo: row.oppoElo, selfElos })}\n`
		);
		rows++;
		queries += selfElos.length;
	}
	await writer.end();
	console.log(`${rows} rows, ${queries} queries (${(queries / rows).toFixed(1)} per row) → ${out}`);
}

if (import.meta.main) await main();
