/**
 * tools/timing-calibration/verify.ts — bot vs human think times on one split.
 *
 *     bun tools/timing-calibration/verify.ts --label before --table identity
 *     bun tools/timing-calibration/verify.ts --label after --table shipped --fast-reply --hover
 *     bun tools/timing-calibration/verify.ts --table data/timing/calib/fit/fit-table.json --split holdout
 *
 * Replays the split's selected sides (`sim.ts`) and compares, per time-control group × rating band ×
 * situation, the bot's recorded thinks with the humans' on the **same positions**. It reports
 * quantiles, the premove (≤ 0.2 s) and sub-second shares with player-cluster bootstrap intervals,
 * CRPS, KS and the one-feature classifier AUC, plus how the bot's moves were made (site premove /
 * fast reply / planned). It writes `verify/<label>/report.md` and `summary.json`.
 */

import "../lib/defines";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
	TIMING_CALIBRATION,
	TIMING_CALIBRATION_IDENTITY,
	type TimingCalibrationTable,
} from "@core/constants/timing-calibration";
import { flagValue, hasFlag } from "../lib/cli";
import { bandOf, PATHS, SITUATIONS, TC_GROUPS, wideBandOf } from "./common";
import { type BotPath, loadReplay, type ReplayData, type SimOptions, simulate } from "./sim";
import { type Comparison, compare, type Obs } from "./stats";

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

const f2 = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v.toFixed(2) : "–");
const pct = (v: number | undefined) =>
	v !== undefined && Number.isFinite(v) ? `${Math.round(100 * v)}%` : "–";

export function cellTable(results: readonly CellResult[]): string {
	const lines = [
		"| tc | band | situation | n (h/bot) | median h / bot [bot CI] | q10 h / bot | q25 h / bot | q75 h / bot | q90 h / bot | premove h / bot [bot CI] | < 1 s h / bot | CRPS | KS | AUC | bot paths q/f/p |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const c of results) {
		const h = c.cmp.human;
		const b = c.cmp.bot;
		const total = c.paths.queued + c.paths.fire + c.paths.plan || 1;
		lines.push(
			`| ${c.tcGroup} | ${c.band} | ${c.situation} | ${h.n}/${b.n} | ${f2(h.q[2])} / ${f2(b.q[2])} [${f2(b.ci.q[2]?.lo)}, ${f2(b.ci.q[2]?.hi)}] | ${f2(h.q[0])} / ${f2(b.q[0])} | ${f2(h.q[1])} / ${f2(b.q[1])} | ${f2(h.q[3])} / ${f2(b.q[3])} | ${f2(h.q[4])} / ${f2(b.q[4])} | ${pct(h.premove)} / ${pct(b.premove)} [${pct(b.ci.premove.lo)}, ${pct(b.ci.premove.hi)}] | ${pct(h.sub1)} / ${pct(b.sub1)} | ${f2(c.cmp.crps)} | ${f2(c.cmp.ks)} | ${f2(c.cmp.auc)} | ${pct(c.paths.queued / total)}/${pct(c.paths.fire / total)}/${pct(c.paths.plan / total)} |`
		);
	}
	return lines.join("\n");
}

/**
 * Clock spend: replaying the bot's own clock over each side (base, minus each recorded think, plus
 * the increment), how often it would have flagged before the game's last recorded move, against
 * the humans' own clocks on the same games, and the bot's total spend over the humans' (median over
 * sides). The positions are the humans' own, so this is a check on the budget, not a game outcome.
 */
export function spendReport(
	data: ReplayData,
	results: Map<string, { bot: number[] }>,
	split: string
): string {
	const groups = new Map<
		string,
		{ sides: number; botFlags: number; draws: number; humanFlags: number; ratios: number[] }
	>();
	for (const side of data.sides) {
		if (split !== "all" && side.split !== split) continue;
		const first = side.rows[0]?.row;
		if (!first) continue;
		const g = groups.get(first.tcGroup) ?? {
			sides: 0,
			botFlags: 0,
			draws: 0,
			humanFlags: 0,
			ratios: [],
		};
		g.sides++;
		const last = side.rows[side.rows.length - 1]?.row;
		if (last && last.clockMs - last.thinkMs + last.incMs <= 100) g.humanFlags++;
		const chains = results.get(first.id)?.bot.length ?? 0;
		for (let c = 0; c < chains; c++) {
			let clock = first.baseMs;
			let flagged = false;
			let bot = 0;
			let human = 0;
			for (const rr of side.rows) {
				const ms = results.get(rr.row.id)?.bot[c] ?? rr.row.thinkMs;
				bot += ms;
				human += rr.row.thinkMs;
				clock += rr.row.incMs - ms;
				if (clock <= 0) flagged = true;
			}
			g.draws++;
			if (flagged) g.botFlags++;
			if (human > 0) g.ratios.push(bot / human);
		}
		groups.set(first.tcGroup, g);
	}
	const lines = [
		"| tc | sides | human flagged | bot flagged (replayed clock) | bot / human spend (median) |",
		"|---|---|---|---|---|",
	];
	for (const [tc, g] of groups) {
		const r = [...g.ratios].sort((a, b) => a - b);
		lines.push(
			`| ${tc} | ${g.sides} | ${pct(g.humanFlags / g.sides)} | ${pct(g.botFlags / Math.max(1, g.draws))} | ${f2(r[Math.floor(r.length / 2)])} |`
		);
	}
	return lines.join("\n");
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

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const label = flagValue(argv, "label", "run") ?? "run";
	const split = flagValue(argv, "split", "holdout") ?? "holdout";
	const table = await loadTable(flagValue(argv, "table", "shipped") ?? "shipped");
	const opts: SimOptions = {
		table,
		fastReply: hasFlag(argv, "fast-reply"),
		hover: hasFlag(argv, "hover"),
		chains: Number(flagValue(argv, "chains", "4")),
		seed: flagValue(argv, "seed", "verify") ?? "verify",
	};
	const resamples = Number(flagValue(argv, "resamples", "200"));
	const limit = Number(flagValue(argv, "limit", "0"));
	const data = await loadReplay({
		headsTag: flagValue(argv, "heads-tag", "") ?? "",
		...(limit > 0 ? { limitSides: limit } : {}),
	});
	const t0 = performance.now();
	const results = await simulate(data, opts, (s) => split === "all" || s.split === split);
	const simS = (performance.now() - t0) / 1000;
	const wide = evaluate(cellsOf(data, results, split, wideBandOf), resamples);
	const fine = evaluate(cellsOf(data, results, split, bandOf), resamples).filter(
		(c) =>
			(c.tcGroup === "bullet" || c.tcGroup === "blitz") &&
			c.band >= 2200 &&
			["book", "recapture", "all"].includes(c.situation)
	);
	const dir = path.join(PATHS.verify, label);
	mkdirSync(dir, { recursive: true });
	const report = [
		`# timing verify: ${label}`,
		"",
		`split ${split}; table ${flagValue(argv, "table", "shipped")}; fast reply ${opts.fastReply}; hover ${opts.hover}; ${opts.chains} chains; ${results.size} rows; sim ${simS.toFixed(0)} s`,
		"",
		"Headline (situation cells, human-n weighted):",
		"",
		"```",
		JSON.stringify(headline(wide), null, 1),
		"```",
		"",
		"## Clock spend",
		"",
		spendReport(data, results, split),
		"",
		"## 400-Elo bands",
		"",
		cellTable(wide),
		"",
		"## 100-Elo bands, bullet/blitz 2200+, book and recapture",
		"",
		cellTable(fine),
		"",
	].join("\n");
	await Bun.write(path.join(dir, "report.md"), report);
	await Bun.write(
		path.join(dir, "summary.json"),
		`${JSON.stringify({ label, split, options: { ...opts, table: undefined }, headline: headline(wide), wide, fine })}\n`
	);
	console.log(report);
}

if (import.meta.main) await main();
