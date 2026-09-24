/**
 * tools/timing-calibration/fit/table.ts — the fitted table from the saved replays: the premove
 * attempt probability per recapture cell (`P0 · human / bot`, clamped, smoothed, made
 * non-decreasing), the shift per situation by a Viterbi pass over the knots for every budget
 * power (the lowest total objective wins), and the TypeScript literal `--write` installs.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import {
	TIMING_CALIBRATION_LIMITS,
	TIMING_CALIBRATION_SITUATIONS,
	type TimingCalibrationClass,
	type TimingCalibrationSituation,
	type TimingCalibrationTable,
	type TimingCalibrationTimeClass,
} from "@core/constants/timing-calibration";
import { PATHS } from "../common";
import {
	BANDS,
	type CellMap,
	CLASSES,
	cellKey,
	KNOTS,
	MIN_CELL,
	N_EFF_MAX,
	objective,
	P0,
	type SplitKey,
} from "./cells";
import { isotonic, smoothWeighted, viterbi } from "./smoothing";

export const SMOOTH_SHIFT = 30;
/**
 * A light prior towards no shift, `PRIOR_SHIFT · g²` per knot: where the objective is flat (a
 * floor or a cap decides the recorded time whatever the plan) the table stays at 0 instead of
 * wandering to a grid edge. It only breaks near-ties: 1.0 of shift costs what a 0.1 log-quantile
 * error over 50 moves does.
 */
export const PRIOR_SHIFT = 2;
export const SMOOTH_PREMOVE = 30;

export function withAll(
	base: TimingCalibrationTable,
	edit: (c: TimingCalibrationClass) => TimingCalibrationClass
): TimingCalibrationTable {
	return { bullet: edit(base.bullet), blitz: edit(base.blitz), rapid: edit(base.rapid) };
}

export function constantShift(g: number): TimingCalibrationClass["shift"] {
	const v = KNOTS.map(() => g);
	return { forced: v, book: v, recapture: v, check: v, ordinary: v };
}

/** The premove table fitted on `source` (identity shifts). */
export async function premoveTable(source: SplitKey): Promise<TimingCalibrationTable> {
	const cells = (await Bun.file(path.join(PATHS.fit, "premove.json")).json()) as CellMap;
	return {
		bullet: premoveClass("bullet", cells, source),
		blitz: premoveClass("blitz", cells, source),
		rapid: premoveClass("rapid", cells, source),
	};
}

function premoveClass(
	cls: TimingCalibrationTimeClass,
	cells: CellMap,
	source: SplitKey
): TimingCalibrationClass {
	const y: number[] = [];
	const w: number[] = [];
	for (const band of BANDS) {
		const c = cells[cellKey(cls, band, "recapture", source)];
		if (!c || c.humanN < MIN_CELL || c.botPremove === 0) {
			y.push(0);
			w.push(0);
			continue;
		}
		const h = c.humanPremove / c.humanN;
		const b = c.botPremove / c.botN;
		y.push(Math.min(1, (P0 * h) / b));
		w.push(Math.min(c.humanN, N_EFF_MAX) / 100);
	}
	const smooth = smoothWeighted(y, w, SMOOTH_PREMOVE / 100, P0);
	const mono = isotonic(
		smooth,
		w.map((x) => x + 0.01)
	);
	const L = TIMING_CALIBRATION_LIMITS;
	return {
		knots: [...KNOTS],
		budgetPower: 1,
		shift: constantShift(0),
		premove: {
			recapture: mono.map((v) => round3(Math.min(L.premoveMax, Math.max(L.premoveMin, v)))),
			other: null,
		},
	};
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Every saved surface, grouped by budget power, each group's grid ascending. */
async function shiftSurfaces(): Promise<Map<number, { grid: number[]; runs: CellMap[] }>> {
	const byPower = new Map<number, Array<{ g: number; f: string }>>();
	for (const f of readdirSync(PATHS.fit)) {
		const m = /^shift_p(\d+\.\d+)_(-?\d+\.\d+)\.json$/.exec(f);
		if (!m) continue;
		const list = byPower.get(Number(m[1])) ?? [];
		list.push({ g: Number(m[2]), f });
		byPower.set(Number(m[1]), list);
	}
	const out = new Map<number, { grid: number[]; runs: CellMap[] }>();
	for (const [power, list] of byPower) {
		list.sort((a, b) => a.g - b.g);
		const runs: CellMap[] = [];
		for (const e of list) runs.push((await Bun.file(path.join(PATHS.fit, e.f)).json()) as CellMap);
		out.set(power, { grid: list.map((e) => e.g), runs });
	}
	return out;
}

/**
 * The table fitted on `source`. Per class, every budget power with surfaces is fitted (a Viterbi
 * pass per situation) and the power whose total objective is lowest is kept.
 */
export async function fittedTable(
	source: SplitKey,
	lambda = SMOOTH_SHIFT,
	fixedPower?: number
): Promise<TimingCalibrationTable> {
	const premove = await premoveTable(source);
	const surfaces = await shiftSurfaces();
	if (surfaces.size === 0) throw new Error("fit: no shift surfaces (run --stage shift first)");
	const out = {} as Record<TimingCalibrationTimeClass, TimingCalibrationClass>;
	for (const cls of CLASSES) {
		let best: { total: number; c: TimingCalibrationClass } | null = null;
		for (const [power, { grid, runs }] of surfaces) {
			if (fixedPower !== undefined && power !== fixedPower) continue;
			const shift = {} as Record<TimingCalibrationSituation, number[]>;
			let total = 0;
			for (const situation of TIMING_CALIBRATION_SITUATIONS) {
				const cost = BANDS.map((band) =>
					runs.map(
						(run, i) =>
							objective(run[cellKey(cls, band, situation, source)]) + PRIOR_SHIFT * (grid[i] ?? 0) ** 2
					)
				);
				const path = viterbi(grid, cost, lambda);
				shift[situation] = path.map(round3);
				path.forEach((v, k) => {
					total += cost[k]?.[grid.indexOf(v)] ?? 0;
				});
			}
			const c = { knots: [...KNOTS], budgetPower: power, shift, premove: premove[cls].premove };
			if (!best || total < best.total) best = { total, c };
			console.error(`${cls} power ${power}: objective ${total.toFixed(0)}`);
		}
		if (!best) throw new Error(`fit: no surfaces for power ${fixedPower}`);
		out[cls] = best.c;
	}
	return out;
}

/** The TypeScript literal of a table (what `--write` puts between the markers). */
export function tableLiteral(t: TimingCalibrationTable): string {
	const arr = (v: readonly number[] | null) => (v === null ? "null" : `[${v.join(", ")}]`);
	const cls = (c: TimingCalibrationClass) =>
		[
			"\t{",
			`\t\tknots: ${arr(c.knots)},`,
			`\t\tbudgetPower: ${c.budgetPower},`,
			"\t\tshift: {",
			...TIMING_CALIBRATION_SITUATIONS.map((s) => `\t\t\t${s}: ${arr(c.shift[s])},`),
			"\t\t},",
			`\t\tpremove: { recapture: ${arr(c.premove.recapture)}, other: ${arr(c.premove.other)} },`,
			"\t},",
		].join("\n");
	return [
		"export const TIMING_CALIBRATION: TimingCalibrationTable = {",
		...CLASSES.map((k) => `\t${k}:${cls(t[k]).slice(1)}`),
		"};",
	].join("\n");
}
