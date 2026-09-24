/**
 * tools/calibration/fit.ts — fit the Maia strength calibration to chess.com human error rates.
 *
 * Per cell (time class × chess.com bucket R), on the **fit** split only, the bot is replayed on
 * every human position (`sim.ts`) for each candidate `(conditioning offset Δ, temperature T)` —
 * the table under test is flat at `[R, R + Δ, T]` — and its error profile is compared with the
 * humans' of the same positions (`stats.ts`: expected-points loss and the inaccuracy / mistake /
 * blunder rates, cluster-robust by game) and, when `rating-eval.ts --train` has written the rating
 * model, the rating the bot plays at by that Maia-free model (paired with the humans over the same
 * positions) against the target. The cell's objective surface is saved.
 *
 * The smoothing stage then picks one evaluated point per cell by a monotone Viterbi pass over
 * the buckets (`smoothClass`, `JOINT`): the fit objective, plus a mild prior towards Maia as
 * advertised that only decides among statistically equivalent points, plus smoothness between
 * neighbours, with the conditioning rating never decreasing in R. `--write` replaces `MAIA_CALIBRATION` in
 * `src/core/constants/maia-calibration.ts` with the knots.
 *
 *   bun tools/calibration/fit.ts [--cells DIR] [--out DIR] [--workers 9] [--chains 4]
 *       [--offsets -600:1000:100] [--temps 0.3,0.4,…,1.8] [--only blitz:1600,…] [--seed S]
 *   bun tools/calibration/fit.ts --smooth [--write]        # from the saved surfaces only
 *   bun tools/calibration/fit.ts --worker --cell blitz:1600 …   (internal)
 */

import "../lib/defines";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { MAIA } from "@core/constants/maia";
import {
	MAIA_CALIBRATION_TIME_CLASSES,
	type MaiaCalibrationKnot,
	type MaiaCalibrationTable,
	type MaiaCalibrationTimeClass,
} from "@core/constants/maia-calibration";
import { DATA_DIR } from "./common";
import { jsonlLines } from "./frames";
import { MODEL_FILE, type ModelSet } from "./rating-eval";
import { cellRating } from "./rating-model";
import { CELLS_DIR, cellFile } from "./shard";
import { type CellItem, groupGames, simulateMany } from "./sim";
import { FIT_METRICS, objective, type Profile, profiles, zScore } from "./stats";

export const FIT_DIR = path.join(DATA_DIR, "fit");
const ROOT = path.resolve(import.meta.dir, "../..");
const CONSTANTS_FILE = path.join(ROOT, "src/core/constants/maia-calibration.ts");

// ── args ─────────────────────────────────────────────────────────────────────────────────────

interface Args {
	cells: string;
	out: string;
	workers: number;
	chains: number;
	offsets: number[];
	temps: number[];
	only: string[];
	seed: string;
	worker: boolean;
	cell?: string;
	smooth: boolean;
	write: boolean;
	/** The players the table is fitted on (`all` = both splits: the shipped table). */
	split: "fit" | "holdout" | "all";
	/** The rating model file (trained on the same players as the fit). */
	model: string;
	/** Coarse grid (every other value) then the full grid's neighbours of the best point. */
	refine: boolean;
	/** `JOINT.smooth.weight` override for `--smooth` (the weight is chosen on held-out players). */
	smoothWeight: number;
}

function range(spec: string): number[] {
	const [a, b, s] = spec.split(":").map(Number);
	if (a === undefined || b === undefined || s === undefined || !(s > 0))
		throw new Error(`bad range ${spec}`);
	const out: number[] = [];
	for (let v = a; v <= b + 1e-9; v += s) out.push(Math.round(v * 1000) / 1000);
	return out;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		cells: CELLS_DIR,
		out: FIT_DIR,
		workers: 9,
		chains: 4,
		offsets: range("-600:1000:100"),
		temps: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8],
		only: [],
		seed: "calibration",
		worker: false,
		smooth: false,
		write: false,
		split: "fit",
		model: MODEL_FILE,
		refine: true,
		smoothWeight: JOINT.smooth.weight,
	};
	for (let i = 0; i < argv.length; i++) {
		const v = argv[i + 1];
		switch (argv[i]) {
			case "--cells":
				args.cells = v ?? args.cells;
				i++;
				break;
			case "--out":
				args.out = v ?? args.out;
				i++;
				break;
			case "--workers":
				args.workers = Number(v);
				i++;
				break;
			case "--chains":
				args.chains = Number(v);
				i++;
				break;
			case "--offsets":
				args.offsets = range(v ?? "");
				i++;
				break;
			case "--temps":
				args.temps = (v ?? "").split(",").map(Number);
				i++;
				break;
			case "--only":
				args.only = (v ?? "").split(",").filter(Boolean);
				i++;
				break;
			case "--seed":
				args.seed = v ?? args.seed;
				i++;
				break;
			case "--cell":
				if (v !== undefined) args.cell = v;
				i++;
				break;
			case "--worker":
				args.worker = true;
				break;
			case "--smooth":
				args.smooth = true;
				break;
			case "--split":
				args.split = v as Args["split"];
				i++;
				break;
			case "--model":
				args.model = v ?? args.model;
				i++;
				break;
			case "--smooth-weight":
				args.smoothWeight = Number(v);
				i++;
				break;
			case "--full-grid":
				args.refine = false;
				break;
			case "--write":
				args.write = true;
				break;
			default:
				throw new Error(`unknown argument ${argv[i]}`);
		}
	}
	return args;
}

// ── loading ──────────────────────────────────────────────────────────────────────────────────

export async function loadCell(
	file: string,
	split?: "fit" | "holdout" | "all"
): Promise<CellItem[]> {
	const items: CellItem[] = [];
	for await (const line of jsonlLines(file)) {
		const item = JSON.parse(line) as CellItem;
		if (split === undefined || split === "all" || item.row.split === split) items.push(item);
	}
	return items;
}

/** A table flat at `[R, R + Δ, T]` in every class (only the row's own class is ever read). */
export function flatTable(R: number, conditioning: number, T: number): MaiaCalibrationTable {
	const knots: MaiaCalibrationKnot[] = [[R, conditioning, T]];
	return { bullet: knots, blitz: knots, rapid: knots };
}

// ── worker: one cell's surface ───────────────────────────────────────────────────────────────

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

async function runWorker(args: Args): Promise<void> {
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

// ── orchestrator ─────────────────────────────────────────────────────────────────────────────

function cellsIn(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => /^(bullet|blitz|rapid)-\d+\.jsonl$/.test(f))
		.map((f) => f.replace(/\.jsonl$/, "").replace("-", ":"))
		.sort((a, b) => {
			const [ta, ba] = a.split(":");
			const [tb, bb] = b.split(":");
			return ta === tb ? Number(ba) - Number(bb) : (ta ?? "") < (tb ?? "") ? -1 : 1;
		});
}

async function orchestrate(args: Args): Promise<void> {
	let cells = cellsIn(args.cells);
	if (args.only.length > 0) cells = cells.filter((c) => args.only.includes(c));
	const done = (c: string) =>
		existsSync(path.join(args.out, "cells", `${c.replace(":", "-")}.json`));
	const queue = cells.filter((c) => !done(c));
	console.log(`${cells.length} cells, ${queue.length} to fit, ${args.workers} workers`);
	const passthrough = [
		"--cells",
		args.cells,
		"--out",
		args.out,
		"--chains",
		String(args.chains),
		"--temps",
		args.temps.join(","),
		"--offsets",
		`${args.offsets[0]}:${args.offsets[args.offsets.length - 1]}:${(args.offsets[1] ?? 0) - (args.offsets[0] ?? 0) || 100}`,
		"--seed",
		args.seed,
		"--split",
		args.split,
		"--model",
		args.model,
		...(args.refine ? [] : ["--full-grid"]),
	];
	const started = performance.now();
	const runOne = async (): Promise<void> => {
		for (;;) {
			const cell = queue.shift();
			if (cell === undefined) return;
			const proc = Bun.spawn(
				[process.execPath, import.meta.path, ...passthrough, "--worker", "--cell", cell],
				{ stdout: "inherit", stderr: "inherit" }
			);
			const code = await proc.exited;
			if (code !== 0) console.error(`${cell}: worker exited ${code}`);
			else
				console.log(
					`${cell} fitted (${((performance.now() - started) / 60_000).toFixed(1)} min elapsed, ${queue.length} queued)`
				);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, args.workers) }, runOne));
	await smooth(args);
}

// ── smoothing and the table ──────────────────────────────────────────────────────────────────

/**
 * The joint choice's penalties. Conditioning and temperature trade off (both move strength), so
 * a cell's surface has a valley of statistically equivalent points; these pick one point per cell,
 * all of them actually evaluated:
 *
 *   - `prior`: `((Δ / elo)² + ((T − 1) / temperature)²)` — the least departure from Maia as
 *     advertised (condition at the target, T = 1) among near-equivalent points; one χ² unit for
 *     400 Elo or 0.4 in T, so it only decides inside the valley;
 *   - `smooth`: between neighbouring buckets, the conditioning step's departure from the buckets'
 *     own spacing and the temperature step, in the same units;
 *   - the conditioning never decreases with the target (a hard constraint).
 */
export const JOINT = {
	prior: { elo: 400, temperature: 0.4, weight: 0.25 },
	smooth: { elo: 300, temperature: 0.2, weight: 12 },
	/** Cells with fewer fit games than this are left out (the edge knots extrapolate over them). */
	minGames: 20,
} as const;

export interface Pick {
	tc: MaiaCalibrationTimeClass;
	bucket: number;
	conditioning: number;
	temperature: number;
	point: SurfacePoint;
	minObjective: number;
	surface: CellSurface;
}

/**
 * The cheapest monotone path through the cells' evaluated points (Viterbi over buckets):
 * Σ objective + prior + smoothness, subject to non-decreasing conditioning.
 */
export function smoothClass(
	surfaces: readonly CellSurface[],
	smoothWeight: number = JOINT.smooth.weight
): Pick[] {
	const cells = surfaces
		.filter((s) => s.games >= JOINT.minGames)
		.sort((a, b) => a.bucket - b.bucket);
	if (cells.length === 0) return [];
	const P = JOINT.prior;
	const S = JOINT.smooth;
	const local = (p: SurfacePoint): number =>
		p.objective + P.weight * ((p.offset / P.elo) ** 2 + ((p.temperature - 1) / P.temperature) ** 2);
	const step = (a: CellSurface, pa: SurfacePoint, b: CellSurface, pb: SurfacePoint): number => {
		const ca = a.bucket + pa.offset;
		const cb = b.bucket + pb.offset;
		if (cb < ca) return Number.POSITIVE_INFINITY;
		const spacing = b.bucket - a.bucket;
		return (
			smoothWeight *
			(((cb - ca - spacing) / S.elo) ** 2 + ((pb.temperature - pa.temperature) / S.temperature) ** 2)
		);
	};
	const first = cells[0] as CellSurface;
	let cost = first.points.map((p) => local(p));
	const back: number[][] = [];
	for (let i = 1; i < cells.length; i++) {
		const prev = cells[i - 1] as CellSurface;
		const cur = cells[i] as CellSurface;
		const next: number[] = [];
		const from: number[] = [];
		for (const pb of cur.points) {
			let best = Number.POSITIVE_INFINITY;
			let arg = 0;
			for (const [j, pa] of prev.points.entries()) {
				const c = (cost[j] as number) + step(prev, pa, cur, pb);
				if (c < best) {
					best = c;
					arg = j;
				}
			}
			next.push(best + local(pb));
			from.push(arg);
		}
		cost = next;
		back.push(from);
	}
	let j = cost.indexOf(Math.min(...cost));
	const chosen: number[] = [j];
	for (let i = back.length - 1; i >= 0; i--) {
		j = (back[i] as number[])[j] as number;
		chosen.unshift(j);
	}
	return cells.map((s, i) => {
		const point = s.points[chosen[i] as number] as SurfacePoint;
		return {
			tc: s.tc,
			bucket: s.bucket,
			conditioning: s.bucket + point.offset,
			temperature: point.temperature,
			point,
			minObjective: Math.min(...s.points.map((p) => p.objective)),
			surface: s,
		};
	});
}

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

async function smooth(args: Args): Promise<void> {
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

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	if (args.worker) await runWorker(args);
	else if (args.smooth) await smooth(args);
	else await orchestrate(args);
}

if (import.meta.main) await main();
