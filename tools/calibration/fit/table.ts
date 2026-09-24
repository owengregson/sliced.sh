/**
 * tools/calibration/fit/table.ts — the smoothed picks as outputs: the knots that actually run
 * (floored and capped as `maiaSelfElo` does), `picks.json`, `table-smooth<W>.json`, and the
 * `MAIA_CALIBRATION` source written into `src/core/constants/maia-calibration.ts` by `--write`.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { MAIA } from "@core/constants/maia";
import { MAIA_CALIBRATION_TIME_CLASSES } from "@core/constants/maia-calibration";
import { ROOT } from "../../lib/paths";
import type { FitArgs } from "./args";
import { type Pick, smoothClass } from "./smooth";
import type { CellSurface } from "./surface";

const CONSTANTS_FILE = path.join(ROOT, "src/core/constants/maia-calibration.ts");

/** The conditioning that actually runs: floored and capped as `maiaSelfElo` does. */
function runConditioning(c: number): number {
	return Math.max(MAIA.context.eloFloor, Math.min(MAIA.conditioningEloMax, c));
}

export function tableSource(picks: readonly Pick[]): string {
	const lines = ["export const MAIA_CALIBRATION: MaiaCalibrationTable = {"];
	for (const tc of MAIA_CALIBRATION_TIME_CLASSES) {
		const own = picks.filter((p) => p.tc === tc).sort((a, b) => a.bucket - b.bucket);
		if (own.length === 0) {
			lines.push(`\t${tc}: [[1500, 1500, 1]],`);
			continue;
		}
		lines.push(`\t${tc}: [`);
		// A conditioning outside [eloFloor, cap] runs at the bound (`maiaSelfElo` floors every query,
		// `maiaConditioningElo` caps it); write what runs.
		for (const p of own)
			lines.push(`\t\t[${p.bucket}, ${runConditioning(p.conditioning)}, ${p.temperature}],`);
		lines.push("\t],");
	}
	lines.push("};", "");
	return lines.join("\n");
}

/**
 * The smoothing stage from the saved surfaces: the picks table on the console, `picks.json`,
 * `table-smooth<W>.json`, the TypeScript source, and with `--write` the shipped table.
 */
export async function writeSmoothed(args: FitArgs): Promise<void> {
	const dir = path.join(args.out, "cells");
	const surfaces: CellSurface[] = [];
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")))
		surfaces.push((await Bun.file(path.join(dir, f)).json()) as CellSurface);
	const picks: Pick[] = [];
	for (const tc of MAIA_CALIBRATION_TIME_CLASSES)
		picks.push(
			...smoothClass(
				surfaces.filter((s) => s.tc === tc),
				args.smoothWeight
			)
		);
	const pct = (v: number) => (100 * v).toFixed(2);
	console.log(
		"\n| tc | R | rows | games | Δ | T | obj (min) | EPL h/b | inacc % h/b | mistake % h/b | blunder % h/b |"
	);
	console.log("|---|---:|---:|---:|---:|---:|---:|---|---|---|---|");
	for (const p of picks) {
		const h = p.surface.human;
		const b = p.point.bot;
		console.log(
			`| ${p.tc} | ${p.bucket} | ${p.surface.rows} | ${p.surface.games} | ${p.conditioning - p.bucket} | ${p.temperature} | ${p.point.objective.toFixed(1)} (${p.minObjective.toFixed(1)}) | ${h.epl.mean.toFixed(4)}/${b.epl.mean.toFixed(4)} | ${pct(h.inacc.mean)}/${pct(b.inacc.mean)} | ${pct(h.mistake.mean)}/${pct(b.mistake.mean)} | ${pct(h.blunder.mean)}/${pct(b.blunder.mean)} |`
		);
	}
	await Bun.write(
		path.join(args.out, "picks.json"),
		`${JSON.stringify(
			picks.map(({ surface, ...p }) => ({ ...p, human: surface.human })),
			null,
			1
		)}\n`
	);
	const source = tableSource(picks);
	const table: Record<string, Array<[number, number, number]>> = {};
	for (const tc of MAIA_CALIBRATION_TIME_CLASSES)
		table[tc] = picks
			.filter((p) => p.tc === tc)
			.sort((a, b) => a.bucket - b.bucket)
			.map((p) => [p.bucket, runConditioning(p.conditioning), p.temperature]);
	await Bun.write(
		path.join(args.out, `table-smooth${args.smoothWeight}.json`),
		`${JSON.stringify(table)}\n`
	);
	console.log(`\n${source}`);
	if (args.write) {
		const text = await Bun.file(CONSTANTS_FILE).text();
		const from = text.indexOf("export const MAIA_CALIBRATION: MaiaCalibrationTable");
		if (from < 0) throw new Error("MAIA_CALIBRATION not found");
		await Bun.write(CONSTANTS_FILE, `${text.slice(0, from)}${source}`);
		console.log(`wrote ${path.relative(ROOT, CONSTANTS_FILE)}`);
	}
}
