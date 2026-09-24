/**
 * tools/timing-calibration/fit.ts — fit the think-time calibration table.
 *
 *     bun tools/timing-calibration/fit.ts --stage premove                  # 1 replay → fit/premove.json
 *     bun tools/timing-calibration/fit.ts --stage shift --grid -1.2,-0.9,…  # replays → fit/shift-<g>.json
 *     bun tools/timing-calibration/fit.ts --stage table --source fit|holdout|all [--out FILE] [--write]
 *
 * The replay (`sim.ts`) runs the production configuration being fitted: the fast-reply search cap
 * and the anticipatory hover on. All selected sides of both splits are replayed in every run, and
 * each run's per-cell statistics are saved **per split**, so a table can be fitted from the fit
 * split, from the holdout split (the cross-fit) or from everyone (the shipped table) without
 * replaying again.
 *
 * **Premove.** How often a safe recapture is premoved is linear in the attempt probability `p`: a
 * premove needs an armed candidate (drawn with `p`), the reply the prediction named, and an
 * opponent think long enough to enter it. So one replay at `p = P0` measures the achievable share
 * per cell. The fitted `p = P0 · human share / bot share` is clamped to [0, 1] and smoothed
 * across rating (below), then made non-decreasing in rating (PAVA), because stronger players
 * premove more.
 *
 * **Shift.** One replay per grid value g, with every situation's shift set to g. For each cell
 * (time class × 400-Elo band × situation) the objective is
 * `n_eff · Σ_q w_q (ln bot_q − ln human_q)²` over the 10/25/50/75/90 % quantiles (weights
 * ½,1,1,1,½, `n_eff = min(human moves, N_EFF_MAX)`). A shift only moves its own cell's moves.
 * The per-game state it could leak through, the AR residual and the pace feedback, is shared
 * evenly, so the cells are fitted jointly by a Viterbi pass over the rating knots: the objective
 * plus `λ·(v_k − v_{k−1})²` between neighbouring knots, where the knots are the bands' centres.
 * Cells with fewer than `MIN_CELL` human moves contribute nothing, and the smoothness fills them.
 */

import "../lib/defines";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
	TIMING_CALIBRATION_IDENTITY,
	TIMING_CALIBRATION_LIMITS,
	TIMING_CALIBRATION_SITUATIONS,
	type TimingCalibrationClass,
	type TimingCalibrationSituation,
	type TimingCalibrationTable,
	type TimingCalibrationTimeClass,
} from "@core/constants/timing-calibration";
import { flagValue, hasFlag } from "../lib/cli";
import { ROOT } from "../lib/paths";
import { PATHS, PREMOVE_MAX_MS, wideBandOf } from "./common";
import { loadReplay, type ReplayData, type SimOptions, simulate } from "./sim";
import { quantileSorted } from "./stats";

export const KNOTS = [800, 1200, 1600, 2000, 2400, 2800, 3100] as const;
const BANDS = [600, 1000, 1400, 1800, 2200, 2600, 3000] as const;
const CLASSES: readonly TimingCalibrationTimeClass[] = ["bullet", "blitz", "rapid"];
const SPLITS = ["fit", "holdout", "all"] as const;
type SplitKey = (typeof SPLITS)[number];
export const P0 = 0.5;
const MIN_CELL = 25;
const N_EFF_MAX = 300;
const Q = [0.1, 0.25, 0.5, 0.75, 0.9] as const;
const QW = [0.5, 1, 1, 1, 0.5] as const;
export const SMOOTH_SHIFT = 30;
/**
 * A light prior towards no shift, `PRIOR_SHIFT · g²` per knot: where the objective is flat (a
 * floor or a cap decides the recorded time whatever the plan) the table stays at 0 instead of
 * wandering to a grid edge. It only breaks near-ties: 1.0 of shift costs what a 0.1 log-quantile
 * error over 50 moves does.
 */
export const PRIOR_SHIFT = 2;
export const SMOOTH_PREMOVE = 30;

const classOf = (tcGroup: string): TimingCalibrationTimeClass =>
	tcGroup.startsWith("rapid") ? "rapid" : (tcGroup as TimingCalibrationTimeClass);

/** Per cell: human and bot sorted thinks (ms) and premove counts. */
interface CellStats {
	humanQ: number[];
	botQ: number[];
	humanN: number;
	botN: number;
	humanPremove: number;
	botPremove: number;
}

type CellMap = Record<string, CellStats>;

function cellKey(cls: string, band: number, situation: string, split: string): string {
	return `${cls}|${band}|${situation}|${split}`;
}

/** Replay once and summarise every cell for every split (and "recapture-premove" pools). */
async function measure(
	data: ReplayData,
	opts: SimOptions,
	only?: TimingCalibrationTimeClass
): Promise<CellMap> {
	const results = await simulate(data, opts, (s) =>
		only === undefined ? true : classOf(s.rows[0]?.row.tcGroup ?? "") === only
	);
	const pools = new Map<string, { h: number[]; b: number[] }>();
	for (const side of data.sides) {
		for (const rr of side.rows) {
			const res = results.get(rr.row.id);
			if (!res) continue;
			const r = rr.row;
			const cls = classOf(r.tcGroup);
			const band = wideBandOf(r.rating);
			for (const split of [side.split, "all"]) {
				const key = cellKey(cls, band, r.situation, split);
				const pool = pools.get(key) ?? { h: [], b: [] };
				pool.h.push(r.thinkMs);
				for (const ms of res.bot) pool.b.push(ms);
				pools.set(key, pool);
			}
		}
	}
	const out: CellMap = {};
	for (const [key, { h, b }] of pools) {
		const hs = h.sort((x, y) => x - y);
		const bs = b.sort((x, y) => x - y);
		out[key] = {
			humanQ: Q.map((q) => quantileSorted(hs, q)),
			botQ: Q.map((q) => quantileSorted(bs, q)),
			humanN: hs.length,
			botN: bs.length,
			humanPremove: hs.filter((v) => v <= PREMOVE_MAX_MS).length,
			botPremove: bs.filter((v) => v <= PREMOVE_MAX_MS).length,
		};
	}
	return out;
}

function withAll(
	base: TimingCalibrationTable,
	edit: (c: TimingCalibrationClass) => TimingCalibrationClass
): TimingCalibrationTable {
	return { bullet: edit(base.bullet), blitz: edit(base.blitz), rapid: edit(base.rapid) };
}

function constantShift(g: number): TimingCalibrationClass["shift"] {
	const v = KNOTS.map(() => g);
	return { forced: v, book: v, recapture: v, check: v, ordinary: v };
}

// ── smoothing ────────────────────────────────────────────────────────────────────────────────

/** Weighted least squares with a first-difference penalty λ: (W + λDᵀD) v = W·y (tridiagonal). */
export function smoothWeighted(
	y: readonly number[],
	w: readonly number[],
	lambda: number,
	fallback = 0
): number[] {
	const n = y.length;
	if (w.every((x) => x <= 0)) return y.map(() => fallback);
	const a = new Array<number>(n).fill(0);
	const b = new Array<number>(n).fill(0);
	const c = new Array<number>(n).fill(0);
	const d = new Array<number>(n).fill(0);
	for (let i = 0; i < n; i++) {
		b[i] = (w[i] ?? 0) + lambda * ((i > 0 ? 1 : 0) + (i < n - 1 ? 1 : 0));
		if (i > 0) a[i] = -lambda;
		if (i < n - 1) c[i] = -lambda;
		d[i] = (w[i] ?? 0) * (y[i] ?? 0);
	}
	// Thomas algorithm (a tiny ridge keeps an all-λ system non-singular).
	for (let i = 0; i < n; i++) b[i] = (b[i] ?? 0) + 1e-9;
	for (let i = 1; i < n; i++) {
		const m = (a[i] ?? 0) / (b[i - 1] ?? 1);
		b[i] = (b[i] ?? 0) - m * (c[i - 1] ?? 0);
		d[i] = (d[i] ?? 0) - m * (d[i - 1] ?? 0);
	}
	const v = new Array<number>(n).fill(0);
	v[n - 1] = (d[n - 1] ?? 0) / (b[n - 1] ?? 1);
	for (let i = n - 2; i >= 0; i--)
		v[i] = ((d[i] ?? 0) - (c[i] ?? 0) * (v[i + 1] ?? 0)) / (b[i] ?? 1);
	return v;
}

/** Pool-adjacent-violators: the weighted non-decreasing fit. */
export function isotonic(y: readonly number[], w: readonly number[]): number[] {
	const blocks: Array<{ v: number; w: number; n: number }> = [];
	for (let i = 0; i < y.length; i++) {
		blocks.push({ v: y[i] ?? 0, w: Math.max(1e-9, w[i] ?? 0), n: 1 });
		while (blocks.length >= 2) {
			const b2 = blocks[blocks.length - 1] as { v: number; w: number; n: number };
			const b1 = blocks[blocks.length - 2] as { v: number; w: number; n: number };
			if (b1.v <= b2.v) break;
			blocks.splice(blocks.length - 2, 2, {
				v: (b1.v * b1.w + b2.v * b2.w) / (b1.w + b2.w),
				w: b1.w + b2.w,
				n: b1.n + b2.n,
			});
		}
	}
	return blocks.flatMap((b) => new Array<number>(b.n).fill(b.v));
}

/** Viterbi over knots: per-knot objective curves on `grid` + λ(v_k − v_{k−1})². */
export function viterbi(
	grid: readonly number[],
	cost: readonly (readonly number[])[],
	lambda: number
): number[] {
	const K = cost.length;
	const G = grid.length;
	let prev = cost[0]?.slice() ?? [];
	const back: number[][] = [];
	for (let k = 1; k < K; k++) {
		const cur = new Array<number>(G).fill(Number.POSITIVE_INFINITY);
		const arg = new Array<number>(G).fill(0);
		for (let j = 0; j < G; j++) {
			for (let i = 0; i < G; i++) {
				const v = (prev[i] ?? 0) + lambda * ((grid[j] ?? 0) - (grid[i] ?? 0)) ** 2;
				if (v < (cur[j] ?? 0)) {
					cur[j] = v;
					arg[j] = i;
				}
			}
			cur[j] = (cur[j] ?? 0) + (cost[k]?.[j] ?? 0);
		}
		back.push(arg);
		prev = cur;
	}
	let best = 0;
	for (let j = 1; j < G; j++) if ((prev[j] ?? 0) < (prev[best] ?? 0)) best = j;
	const path = [best];
	for (let k = K - 2; k >= 0; k--) path.unshift(back[k]?.[path[0] ?? 0] ?? 0);
	return path.map((j) => grid[j] ?? 0);
}

// ── stages ───────────────────────────────────────────────────────────────────────────────────

function fitDir(): string {
	const dir = PATHS.fit;
	mkdirSync(dir, { recursive: true });
	return dir;
}

function simOptions(table: TimingCalibrationTable, chains: number, seed: string): SimOptions {
	return { table, fastReply: true, hover: true, chains, seed };
}

async function stagePremove(chains: number): Promise<void> {
	const data = await loadReplay();
	const table = withAll(TIMING_CALIBRATION_IDENTITY, (c) => ({
		...c,
		knots: [...KNOTS],
		premove: { recapture: KNOTS.map(() => P0), other: null },
	}));
	const cells = await measure(data, simOptions(table, chains, "fit-premove"));
	await Bun.write(path.join(fitDir(), "premove.json"), `${JSON.stringify(cells)}\n`);
	console.log(`premove: ${Object.keys(cells).length} cells`);
}

async function stageShift(
	grid: readonly number[],
	power: number,
	chains: number,
	only?: TimingCalibrationTimeClass
): Promise<void> {
	const data = await loadReplay();
	const premove = await premoveTable("all");
	for (const g of grid) {
		const table = withAll(premove, (c) => ({
			...c,
			knots: [...KNOTS],
			budgetPower: power,
			shift: constantShift(g),
		}));
		const t0 = performance.now();
		const file = path.join(fitDir(), surfaceName(power, g));
		const fresh = await measure(data, simOptions(table, chains, "fit-shift"), only);
		// `--only <class>` refreshes that class's cells in an existing surface and keeps the rest.
		const old =
			only !== undefined && (await Bun.file(file).exists())
				? ((await Bun.file(file).json()) as CellMap)
				: {};
		const cells: CellMap = { ...old };
		if (only !== undefined)
			for (const k of Object.keys(cells)) if (k.startsWith(`${only}|`)) delete cells[k];
		Object.assign(cells, fresh);
		await Bun.write(file, `${JSON.stringify(cells)}\n`);
		console.log(
			`power ${power} shift ${g.toFixed(2)}: ${((performance.now() - t0) / 1000).toFixed(0)} s`
		);
	}
}

const surfaceName = (power: number, g: number) => `shift_p${power.toFixed(2)}_${g.toFixed(2)}.json`;

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

function objective(c: CellStats | undefined): number {
	if (!c || c.humanN < MIN_CELL) return 0;
	const nEff = Math.min(c.humanN, N_EFF_MAX);
	let s = 0;
	for (let i = 0; i < Q.length; i++) {
		const h = Math.max(100, c.humanQ[i] ?? 100);
		const b = Math.max(100, c.botQ[i] ?? 100);
		s += (QW[i] ?? 1) * Math.log(b / h) ** 2;
	}
	return nEff * s;
}

/** Every saved surface, grouped by budget power, each group's grid ascending. */
async function shiftSurfaces(): Promise<Map<number, { grid: number[]; runs: CellMap[] }>> {
	const { readdirSync } = await import("node:fs");
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

async function stageTable(argv: readonly string[]): Promise<void> {
	const source = (flagValue(argv, "source", "all") ?? "all") as SplitKey;
	const lambda = Number(flagValue(argv, "lambda", String(SMOOTH_SHIFT)));
	const power = flagValue(argv, "power");
	const table = await fittedTable(source, lambda, power === undefined ? undefined : Number(power));
	const out = flagValue(argv, "out", path.join(fitDir(), `table-${source}.json`)) ?? "";
	await Bun.write(out, `${JSON.stringify(table, null, "\t")}\n`);
	console.log(tableLiteral(table));
	if (hasFlag(argv, "write")) {
		const file = path.join(ROOT, "src/core/constants/timing-calibration.ts");
		const text = await Bun.file(file).text();
		const begin = text.indexOf("// fitted-table-begin");
		const end = text.indexOf("// fitted-table-end");
		if (begin < 0 || end < 0) throw new Error("fit: table markers missing");
		const next = `${text.slice(0, begin)}// fitted-table-begin\n${tableLiteral(table)}\n${text.slice(end)}`;
		await Bun.write(file, next);
		console.log(`wrote ${file}`);
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const stage = flagValue(argv, "stage");
	const chains = Number(flagValue(argv, "chains", "4"));
	if (stage === "premove") await stagePremove(chains);
	else if (stage === "shift")
		await stageShift(
			(flagValue(argv, "grid", "0") ?? "0").split(",").map(Number),
			Number(flagValue(argv, "power", "1")),
			chains,
			flagValue(argv, "only") as TimingCalibrationTimeClass | undefined
		);
	else if (stage === "table") await stageTable(argv);
	else throw new Error("fit: --stage premove|shift|table");
	process.exit(0);
}

if (import.meta.main) await main();
