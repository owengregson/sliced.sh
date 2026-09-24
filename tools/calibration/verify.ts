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
 *   2. **intrinsic rating**: the Maia-free rating model (`rating-model.ts`, trained on the fit
 *      split's humans by `rating-eval.ts --train`) gives the bot's and the humans' pooled ratings
 *      over the same positions; the players' mean actual rating plus the paired gap (cluster-robust
 *      by game) is the rating the bot plays at.
 *
 *   bun tools/calibration/verify.ts [--table shipped|identity|FILE.json] [--label NAME] [--chains 8]
 *       [--workers 9] [--only blitz:2800,…] [--cells DIR]
 */

import "../human-match/defines";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import {
	MAIA_CALIBRATION,
	MAIA_CALIBRATION_IDENTITY,
	MAIA_CALIBRATION_TIME_CLASSES,
	type MaiaCalibrationTable,
	type MaiaCalibrationTimeClass,
} from "@core/constants/maia-calibration";
import { maiaCalibrationFor } from "@core/strength/maia-calibration";
import { DATA_DIR } from "./common";
import { loadCell } from "./fit";
import { MODEL_FILE, type ModelSet } from "./rating-eval";
import { type CellRating, cellRating } from "./rating-model";
import { CELLS_DIR, cellFile } from "./shard";
import { groupGames, simulate } from "./sim";
import { CLOCK_BINS, METRICS, type Metric, type Profile, profiles, zScore } from "./stats";

const VERIFY_DIR = path.join(DATA_DIR, "verify");

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

interface CellResult {
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

async function runWorker(args: Args): Promise<void> {
	const [tc, bucketText] = (args.cell ?? "").split(":") as [MaiaCalibrationTimeClass, string];
	const bucket = Number(bucketText);
	const started = performance.now();
	const table = await tableFor(args.table);
	const all = await loadCell(cellFile(args.cells, tc, bucket));
	const holdout = all.filter((i) => i.row.split === "holdout");
	const games = groupGames(holdout);
	const rows = simulate(games, { targetElo: bucket, table, chains: args.chains, seed: args.seed });
	const overall = profiles(rows);
	const clock = CLOCK_BINS.map(([bin, lo, hi]) => ({
		bin,
		...profiles(rows, (r) => r.clockFrac >= lo && r.clockFrac < hi),
	}));
	const models = (await Bun.file(MODEL_FILE).json()) as ModelSet;
	const model = models[tc];
	if (!model) throw new Error(`${MODEL_FILE} has no ${tc} model: run rating-eval.ts --train`);
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

// ── report ───────────────────────────────────────────────────────────────────────────────────

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
		out.push(
			"",
			`### ${tc} — intrinsic rating (Maia-free, \`rating-model.ts\`)`,
			"",
			"Pooled per-move likelihood over the same held-out positions; the bot's rating is the players' mean actual rating plus the paired bot − human gap (the estimator's own bias cancels).",
			"",
			"| R | games | humans' estimate | bot's estimate | paired gap ± 1.96 SE | bot plays at | within ±1.96 SE of R |",
			"|---:|---:|---:|---:|---:|---:|:-:|"
		);
		for (const c of own) {
			const r = c.rating;
			if (!r) continue;
			const ok = Math.abs(r.implied - c.bucket) <= 1.96 * r.diffSe;
			out.push(
				`| ${c.bucket} | ${r.games} | ${Math.round(r.human.rating)} | ${Math.round(r.bot.rating)} | ${r.diff >= 0 ? "+" : ""}${Math.round(r.diff)} ± ${Math.round(1.96 * r.diffSe)} | ${Math.round(r.implied)} | ${ok ? "✓" : "✗"} |`
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
		rating: Object.fromEntries(cells.map((c) => [`${c.tc}:${c.bucket}`, c.rating])),
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
