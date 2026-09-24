/**
 * tools/calibration/verify.ts — does the bot play like a chess.com player of the advertised rating?
 *
 * On the **holdout** split (players the fit never saw), per cell, the bot is replayed with a whole
 * calibration table — the shipped `MAIA_CALIBRATION` by default, or `--table identity` for the
 * behaviour before calibration — and judged two independent ways:
 *
 *   1. **error profile**: expected-points loss, inaccuracy / mistake / blunder rates, ACPL and
 *      top-1, bot vs the humans of the same positions, with cluster-robust 95 % intervals and the
 *      standardised difference; also per clock quartile, so the context terms' shape is checked
 *      against how humans actually degrade on the clock;
 *   2. **intrinsic rating**: the Maia-free estimator (`estimator.ts`), trained on the fit split's
 *      humans, applied to the bot's pseudo-games and to the humans' own games over the same
 *      positions; the paired difference over the estimator's slope on held-out humans is the bot's
 *      rating offset, with a game-bootstrap 95 % interval.
 *
 *   bun tools/calibration/verify.ts [--table shipped|identity] [--label NAME] [--chains 8]
 *       [--workers 9] [--only blitz:2800,…] [--cells DIR]
 */

import "../lib/defines";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import {
	MAIA_CALIBRATION,
	MAIA_CALIBRATION_IDENTITY,
	MAIA_CALIBRATION_TIME_CLASSES,
	type MaiaCalibrationTable,
	type MaiaCalibrationTimeClass,
} from "@core/constants/maia-calibration";
import { createRng } from "@core/rng";
import { maiaCalibrationFor } from "@core/strength/maia-calibration";
import { DATA_DIR } from "./common";
import { features, linearFit, type Model, predict, train } from "./estimator";
import { loadCell } from "./fit";
import { CELLS_DIR, cellFile } from "./shard";
import { groupGames, type MoveOutcome, simulate } from "./sim";
import { CLOCK_BINS, METRICS, type Metric, type Profile, profiles, zScore } from "./stats";

const VERIFY_DIR = path.join(DATA_DIR, "verify");
const BOOTSTRAP = 2000;

interface Args {
	table: string;
	label: string;
	chains: number;
	workers: number;
	only: string[];
	cells: string;
	worker: boolean;
	cell?: string;
	seed: string;
	reportOnly: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		table: "shipped",
		label: "",
		chains: 8,
		workers: 9,
		only: [],
		cells: CELLS_DIR,
		worker: false,
		seed: "verify",
		reportOnly: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const v = argv[i + 1] ?? "";
		switch (argv[i]) {
			case "--table":
				args.table = v;
				i++;
				break;
			case "--label":
				args.label = v;
				i++;
				break;
			case "--chains":
				args.chains = Number(v);
				i++;
				break;
			case "--workers":
				args.workers = Number(v);
				i++;
				break;
			case "--only":
				args.only = v.split(",").filter(Boolean);
				i++;
				break;
			case "--cells":
				args.cells = v;
				i++;
				break;
			case "--seed":
				args.seed = v;
				i++;
				break;
			case "--cell":
				args.cell = v;
				i++;
				break;
			case "--worker":
				args.worker = true;
				break;
			case "--report":
				args.reportOnly = true;
				break;
			default:
				throw new Error(`unknown argument ${argv[i]}`);
		}
	}
	if (!args.label) args.label = args.table;
	return args;
}

async function tableFor(spec: string): Promise<MaiaCalibrationTable> {
	if (spec === "shipped") return MAIA_CALIBRATION;
	if (spec === "identity") return MAIA_CALIBRATION_IDENTITY;
	return (await Bun.file(spec).json()) as MaiaCalibrationTable;
}

// ── worker ───────────────────────────────────────────────────────────────────────────────────

interface GameRecord {
	key: string;
	rating: number;
	human: number[] | null;
	bot: Array<number[] | null>;
}

interface CellResult {
	tc: MaiaCalibrationTimeClass;
	bucket: number;
	conditioning: number;
	temperature: number;
	overall: { human: Profile; bot: Profile };
	clock: Array<{ bin: string; human: Profile; bot: Profile }>;
	/** Holdout games: human features and each chain's bot features. */
	games: GameRecord[];
	/** Fit-split human games (the estimator's training set). */
	train: Array<{ rating: number; x: number[] }>;
	meanSelfElo: number;
	seconds: number;
}

async function runWorker(args: Args): Promise<void> {
	const [tc, bucketText] = (args.cell ?? "").split(":") as [MaiaCalibrationTimeClass, string];
	const bucket = Number(bucketText);
	const started = performance.now();
	const table = await tableFor(args.table);
	const all = await loadCell(cellFile(args.cells, tc, bucket));
	const holdout = all.filter((i) => i.row.split === "holdout");
	const fitHumans = groupGames(all.filter((i) => i.row.split === "fit"));
	const games = groupGames(holdout);
	const rows = simulate(games, { targetElo: bucket, table, chains: args.chains, seed: args.seed });
	const overall = profiles(rows);
	const clock = CLOCK_BINS.map(([bin, lo, hi]) => ({
		bin,
		...profiles(rows, (r) => r.clockFrac >= lo && r.clockFrac < hi),
	}));
	const byGame = new Map<string, typeof rows>();
	for (const r of rows) {
		const list = byGame.get(r.gameKey) ?? [];
		list.push(r);
		byGame.set(r.gameKey, list);
	}
	const ratingOf = new Map(games.map((g) => [g.key, g.items[0]?.item.row.selfElo ?? bucket]));
	const records: GameRecord[] = [];
	for (const [key, list] of byGame) {
		const judged = list.filter((r) => r.human !== null);
		const human = features(judged.map((r) => r.human as MoveOutcome));
		const bot = Array.from({ length: args.chains }, (_, k) =>
			features(judged.map((r) => (r.draws[k] as { outcome: MoveOutcome }).outcome))
		);
		records.push({ key, rating: ratingOf.get(key) ?? bucket, human, bot });
	}
	const trainSet: CellResult["train"] = [];
	for (const g of fitHumans) {
		const x = features(g.items.flatMap((i) => (i.human === null ? [] : [i.human])));
		if (x) trainSet.push({ rating: g.items[0]?.item.row.selfElo ?? bucket, x });
	}
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
		games: records,
		train: trainSet,
		meanSelfElo: selfN > 0 ? selfSum / selfN : 0,
		seconds: (performance.now() - started) / 1000,
	};
	const dir = path.join(VERIFY_DIR, args.label, "cells");
	mkdirSync(dir, { recursive: true });
	await Bun.write(path.join(dir, `${tc}-${bucket}.json`), `${JSON.stringify(result)}\n`);
	console.log(`${tc}:${bucket} verified in ${result.seconds.toFixed(0)} s`);
}

// ── report ───────────────────────────────────────────────────────────────────────────────────

interface Rated {
	tc: MaiaCalibrationTimeClass;
	bucket: number;
	implied: number;
	lo: number;
	hi: number;
	games: number;
	humanPred: number;
}

function impliedRatings(cells: readonly CellResult[]): {
	rated: Rated[];
	models: Record<string, Model & { slope: number; r2: number }>;
} {
	const rated: Rated[] = [];
	const models: Record<string, Model & { slope: number; r2: number }> = {};
	for (const tc of MAIA_CALIBRATION_TIME_CLASSES) {
		const own = cells.filter((c) => c.tc === tc);
		const trainSet = own.flatMap((c) => c.train);
		if (trainSet.length < 50) continue;
		const model = train(
			trainSet.map((t) => t.x),
			trainSet.map((t) => t.rating)
		);
		// The estimator's own slope on held-out humans: E[pred | rating] = a + b·rating.
		const hx: number[] = [];
		const hy: number[] = [];
		for (const c of own)
			for (const g of c.games)
				if (g.human) {
					hx.push(g.rating);
					hy.push(predict(model, g.human));
				}
		const { b } = linearFit(hx, hy);
		const my = hy.reduce((s, v) => s + v, 0) / Math.max(1, hy.length);
		const { a } = linearFit(hx, hy);
		let ssr = 0;
		let sst = 0;
		for (let i = 0; i < hx.length; i++) {
			ssr += ((hy[i] as number) - (a + b * (hx[i] as number))) ** 2;
			sst += ((hy[i] as number) - my) ** 2;
		}
		models[tc] = { ...model, slope: b, r2: sst > 0 ? 1 - ssr / sst : 0 };
		for (const c of own) {
			// Paired per game: mean over chains of pred(bot) − pred(human).
			const diffs: number[] = [];
			let humanPred = 0;
			for (const g of c.games) {
				if (!g.human) continue;
				const ph = predict(model, g.human);
				const bots = g.bot.filter((x): x is number[] => x !== null).map((x) => predict(model, x));
				if (bots.length === 0) continue;
				diffs.push(bots.reduce((s, v) => s + v, 0) / bots.length - ph);
				humanPred += ph;
			}
			if (diffs.length < 5 || !(b > 0)) continue;
			const mean = (xs: readonly number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
			const rng = createRng(`bootstrap:${tc}:${c.bucket}`);
			const boots: number[] = [];
			for (let k = 0; k < BOOTSTRAP; k++) {
				let s = 0;
				for (let i = 0; i < diffs.length; i++)
					s += diffs[Math.floor(rng.next() * diffs.length)] as number;
				boots.push(s / diffs.length / b);
			}
			boots.sort((x, y) => x - y);
			const humanRating = mean(c.games.filter((g) => g.human).map((g) => g.rating));
			rated.push({
				tc,
				bucket: c.bucket,
				implied: humanRating + mean(diffs) / b,
				lo: humanRating + (boots[Math.floor(0.025 * BOOTSTRAP)] as number),
				hi: humanRating + (boots[Math.floor(0.975 * BOOTSTRAP)] as number),
				games: diffs.length,
				humanPred: humanPred / diffs.length,
			});
		}
	}
	return { rated, models };
}

function ci(e: { mean: number; se: number }, scale = 1, digits = 2): string {
	return `${(e.mean * scale).toFixed(digits)} ± ${(1.96 * e.se * scale).toFixed(digits)}`;
}

const SHOWN: ReadonlyArray<readonly [Metric, string, number, number]> = [
	["epl", "EPL", 1, 4],
	["inacc", "inacc %", 100, 1],
	["mistake", "mistake %", 100, 1],
	["blunder", "blunder %", 100, 2],
	["acpl", "ACPL", 1, 1],
	["top1", "top-1 %", 100, 1],
];

async function report(args: Args): Promise<void> {
	const dir = path.join(VERIFY_DIR, args.label, "cells");
	const cells: CellResult[] = [];
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")))
		cells.push((await Bun.file(path.join(dir, f)).json()) as CellResult);
	cells.sort((a, b) => (a.tc === b.tc ? a.bucket - b.bucket : a.tc < b.tc ? -1 : 1));
	const { rated, models } = impliedRatings(cells);
	const out: string[] = [
		`# Maia calibration verification — table \`${args.table}\``,
		"",
		`Held-out chess.com players only; ${args.chains} bot chains per game. Each cell: humans vs the bot over the same positions, cluster-robust 95 % intervals (by game). z = (bot − human)/SE; |z| ≤ 2 is statistically indistinguishable.`,
		"",
	];
	for (const tc of MAIA_CALIBRATION_TIME_CLASSES) {
		const own = cells.filter((c) => c.tc === tc);
		if (own.length === 0) continue;
		out.push(`## ${tc}`, "");
		out.push(
			`| R | cond. | T | mean Maia E | moves | ${SHOWN.map(([, n]) => `${n} human | bot | z`).join(" | ")} |`
		);
		out.push(`|---:|---:|---:|---:|---:|${SHOWN.map(() => "---:|---:|---:").join("|")}|`);
		for (const c of own) {
			const h = c.overall.human;
			const b = c.overall.bot;
			out.push(
				`| ${c.bucket} | ${Math.round(c.conditioning)} | ${c.temperature} | ${Math.round(c.meanSelfElo)} | ${h.epl.n} | ${SHOWN.map(
					([m, , s, d]) => `${ci(h[m], s, d)} | ${ci(b[m], s, d)} | ${zScore(h, b, m).toFixed(1)}`
				).join(" | ")} |`
			);
		}
		out.push("", `### ${tc} — blunder % by clock quartile (human / bot)`, "");
		out.push(`| R | ${CLOCK_BINS.map(([n]) => n).join(" | ")} |`);
		out.push(`|---:|${CLOCK_BINS.map(() => "---").join("|")}|`);
		for (const c of own)
			out.push(
				`| ${c.bucket} | ${c.clock
					.map(
						(q) =>
							`${(100 * q.human.blunder.mean).toFixed(1)} / ${(100 * q.bot.blunder.mean).toFixed(1)} (${q.human.blunder.n})`
					)
					.join(" | ")} |`
			);
		out.push("", `### ${tc} — mistake-or-worse % by clock quartile (human / bot)`, "");
		out.push(`| R | ${CLOCK_BINS.map(([n]) => n).join(" | ")} |`);
		out.push(`|---:|${CLOCK_BINS.map(() => "---").join("|")}|`);
		for (const c of own)
			out.push(
				`| ${c.bucket} | ${c.clock
					.map(
						(q) => `${(100 * q.human.mistake.mean).toFixed(1)} / ${(100 * q.bot.mistake.mean).toFixed(1)}`
					)
					.join(" | ")} |`
			);
		const m = models[tc];
		if (m) {
			out.push(
				"",
				`### ${tc} — intrinsic rating (Maia-free estimator)`,
				"",
				`Ridge regression on ${m.trainedOn} fit-split human games; held-out slope ${m.slope.toFixed(3)} (pred per Elo), R² ${m.r2.toFixed(2)}, per-game residual SD ${Math.round(m.residualSd)}.`,
				"",
				"| R | games | bot's implied rating | 95 % interval | offset |",
				"|---:|---:|---:|---|---:|"
			);
			for (const r of rated.filter((r) => r.tc === tc))
				out.push(
					`| ${r.bucket} | ${r.games} | ${Math.round(r.implied)} | ${Math.round(r.lo)} – ${Math.round(r.hi)} | ${r.implied - r.bucket >= 0 ? "+" : ""}${Math.round(r.implied - r.bucket)} |`
				);
		}
		out.push("");
	}
	const summary = {
		table: args.table,
		cells: cells.map((c) => ({
			tc: c.tc,
			bucket: c.bucket,
			conditioning: c.conditioning,
			temperature: c.temperature,
			meanSelfElo: c.meanSelfElo,
			human: Object.fromEntries(METRICS.map((m) => [m, c.overall.human[m]])),
			bot: Object.fromEntries(METRICS.map((m) => [m, c.overall.bot[m]])),
			z: Object.fromEntries(METRICS.map((m) => [m, zScore(c.overall.human, c.overall.bot, m)])),
			clock: c.clock.map((q) => ({
				bin: q.bin,
				human: { blunder: q.human.blunder, mistake: q.human.mistake },
				bot: { blunder: q.bot.blunder, mistake: q.bot.mistake },
			})),
		})),
		implied: rated,
		estimator: Object.fromEntries(
			Object.entries(models).map(([tc, m]) => [tc, { slope: m.slope, r2: m.r2, n: m.trainedOn }])
		),
	};
	const base = path.join(VERIFY_DIR, args.label);
	await Bun.write(path.join(base, "report.md"), out.join("\n"));
	await Bun.write(path.join(base, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
	console.log(out.join("\n"));
	console.log(`wrote ${path.join(base, "report.md")}`);
}

// ── orchestrator ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.worker) return runWorker(args);
	if (!args.reportOnly) {
		const cells = readdirSync(args.cells)
			.filter((f) => /^(bullet|blitz|rapid)-\d+\.jsonl$/.test(f))
			.map((f) => f.replace(/\.jsonl$/, "").replace("-", ":"))
			.filter((c) => args.only.length === 0 || args.only.includes(c));
		const done = (c: string) =>
			existsSync(path.join(VERIFY_DIR, args.label, "cells", `${c.replace(":", "-")}.json`));
		const queue = cells.filter((c) => !done(c));
		console.log(`${cells.length} cells, ${queue.length} to verify with table ${args.table}`);
		const worker = async (): Promise<void> => {
			for (;;) {
				const cell = queue.shift();
				if (cell === undefined) return;
				const proc = Bun.spawn(
					[
						process.execPath,
						import.meta.path,
						"--worker",
						"--cell",
						cell,
						"--table",
						args.table,
						"--label",
						args.label,
						"--chains",
						String(args.chains),
						"--cells",
						args.cells,
						"--seed",
						args.seed,
					],
					{ stdout: "inherit", stderr: "inherit" }
				);
				const code = await proc.exited;
				if (code !== 0) console.error(`${cell}: worker exited ${code}`);
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, args.workers) }, worker));
	}
	await report(args);
}

if (import.meta.main) await main();
