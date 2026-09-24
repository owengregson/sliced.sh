/**
 * tools/timing-calibration/verify/cells.ts — bot vs human per cell: the replayed rows grouped by
 * time-control group × band × situation (plus "all"), each cell compared on the same positions,
 * the headline over situation cells, and the table specs the tools accept.
 */

import {
	TIMING_CALIBRATION,
	TIMING_CALIBRATION_IDENTITY,
	type TimingCalibrationTable,
} from "@core/constants/timing-calibration";
import { SITUATIONS, TC_GROUPS } from "../common";
import type { BotPath, ReplayData } from "../sim";
import { type Comparison, compare, type Obs } from "../stats";

export async function loadTable(spec: string): Promise<TimingCalibrationTable> {
	if (spec === "identity") return TIMING_CALIBRATION_IDENTITY;
	if (spec === "shipped") return TIMING_CALIBRATION;
	return (await Bun.file(spec).json()) as TimingCalibrationTable;
}

export interface CellResult {
	tcGroup: string;
	band: number;
	situation: string;
	cmp: Comparison;
	paths: Record<BotPath, number>;
}

export interface CellInput {
	human: Obs[];
	bot: Obs[];
	paths: Record<BotPath, number>;
}

/** Group replayed rows into cells; `bands` picks the banding(s). */
export function cellsOf(
	data: ReplayData,
	results: Map<string, { bot: number[]; path: BotPath[] }>,
	split: string,
	band: (rating: number) => number,
	extraKey = ""
): Map<string, CellInput> {
	const cells = new Map<string, CellInput>();
	for (const side of data.sides) {
		if (split !== "all" && side.split !== split) continue;
		for (const rr of side.rows) {
			const res = results.get(rr.row.id);
			if (!res) continue;
			const r = rr.row;
			for (const situation of [r.situation, "all"]) {
				const key = `${r.tcGroup}\t${band(r.rating)}\t${situation}${extraKey}`;
				let c = cells.get(key);
				if (!c) {
					c = { human: [], bot: [], paths: { queued: 0, fire: 0, plan: 0 } };
					cells.set(key, c);
				}
				c.human.push({ ms: r.thinkMs, cluster: r.player });
				for (let i = 0; i < res.bot.length; i++) {
					c.bot.push({ ms: res.bot[i] ?? 0, cluster: r.player });
					const p = res.path[i];
					if (p) c.paths[p]++;
				}
			}
		}
	}
	return cells;
}

export function evaluate(
	cells: Map<string, CellInput>,
	resamples: number,
	minHuman = 25
): CellResult[] {
	const out: CellResult[] = [];
	for (const [key, c] of cells) {
		if (c.human.length < minHuman) continue;
		const [tcGroup, band, situation] = key.split("\t") as [string, string, string];
		out.push({
			tcGroup,
			band: Number(band),
			situation,
			cmp: compare(c.human, c.bot, resamples),
			paths: c.paths,
		});
	}
	const tcIndex = (g: string) => TC_GROUPS.indexOf(g as (typeof TC_GROUPS)[number]);
	const sitIndex = (s: string) => [...SITUATIONS, "all"].indexOf(s);
	return out.sort(
		(a, b) =>
			tcIndex(a.tcGroup) - tcIndex(b.tcGroup) ||
			a.band - b.band ||
			sitIndex(a.situation) - sitIndex(b.situation)
	);
}

/** Headline scores over cells (weighted by human n): mean |AUC − ½|, mean KS, mean log-median error. */
export function headline(results: readonly CellResult[]): Record<string, number> {
	let w = 0;
	let auc = 0;
	let ks = 0;
	let logMed = 0;
	let pre = 0;
	for (const c of results) {
		if (c.situation === "all") continue;
		const n = c.cmp.human.n;
		w += n;
		auc += n * Math.abs(c.cmp.auc - 0.5);
		ks += n * c.cmp.ks;
		logMed += n * Math.abs(Math.log((c.cmp.bot.q[2] ?? 1) / (c.cmp.human.q[2] ?? 1)));
		pre += n * Math.abs(c.cmp.bot.premove - c.cmp.human.premove);
	}
	return {
		cells: results.length,
		aucDev: auc / w,
		ks: ks / w,
		logMedianErr: logMed / w,
		premoveErr: pre / w,
	};
}
