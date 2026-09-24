/**
 * tools/timing-calibration/human-report.ts — the humans alone: think-time quantiles, premove and
 * sub-second shares per time-control group × rating band × situation, player-capped, with
 * player-cluster bootstrap intervals.
 *
 *     bun tools/timing-calibration/human-report.ts [--labels FILE] [--cap 30] [--wide] [--out FILE]
 *
 * It streams `labels.jsonl` (the crawl's runs to tens of millions of rows) and keeps only the thinks
 * per (cell, player). The cap is applied on the fly: the first `--cap` games seen of a
 * (player, time class) are kept.
 */

import "../lib/defines";
import { flagValue, hasFlag } from "../lib/cli";
import {
	bandOf,
	type LabelRow,
	PATHS,
	readJsonl,
	SITUATIONS,
	TC_GROUPS,
	tcGroupOf,
	wideBandOf,
} from "./common";
import { type SummaryCI, summariseGroups } from "./stats";

export interface HumanCell {
	tcGroup: string;
	band: number;
	situation: string;
	summary: SummaryCI;
}

/** Streaming accumulation of labelled thinks into per-cell, per-player groups. */
export class HumanAccumulator {
	private readonly cells = new Map<string, Map<string, number[]>>();
	private readonly sides = new Map<string, Set<string>>();
	rows = 0;

	constructor(
		private readonly band: (rating: number) => number,
		private readonly cap: number
	) {}

	add(r: LabelRow): void {
		if (r.first || r.kept === false) return;
		const sideKey = `${r.player}\t${r.tc}`;
		let games = this.sides.get(sideKey);
		if (!games) {
			games = new Set();
			this.sides.set(sideKey, games);
		}
		if (!games.has(r.gameId)) {
			if (games.size >= this.cap) return;
			games.add(r.gameId);
		}
		this.rows++;
		const g = tcGroupOf(r.tc, r.control);
		const b = this.band(r.rating);
		for (const situation of [r.situation, "all"]) {
			const key = `${g}\t${b}\t${situation}`;
			let cell = this.cells.get(key);
			if (!cell) {
				cell = new Map();
				this.cells.set(key, cell);
			}
			const list = cell.get(r.player);
			if (list) list.push(r.thinkMs);
			else cell.set(r.player, [r.thinkMs]);
		}
	}

	build(resamples: number): HumanCell[] {
		const out: HumanCell[] = [];
		for (const [key, players] of this.cells) {
			const [tcGroup, b, situation] = key.split("\t") as [string, string, string];
			out.push({
				tcGroup,
				band: Number(b),
				situation,
				summary: summariseGroups([...players.values()], resamples, key),
			});
		}
		const tcIndex = (g: string) => TC_GROUPS.indexOf(g as (typeof TC_GROUPS)[number]);
		return out.sort(
			(a, b) =>
				tcIndex(a.tcGroup) - tcIndex(b.tcGroup) ||
				a.band - b.band ||
				a.situation.localeCompare(b.situation)
		);
	}
}

const f1 = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v.toFixed(2) : "–");
const pct = (v: number | undefined) =>
	v !== undefined && Number.isFinite(v) ? `${(100 * v).toFixed(0)}%` : "–";

export function humanTable(cells: readonly HumanCell[], minN = 30): string {
	const lines = [
		"| tc | band | situation | n | players | q10 | q25 | median [95% CI] | q75 | q90 | premove [CI] | < 1 s |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const c of cells) {
		const s = c.summary;
		if (s.n < minN) continue;
		lines.push(
			`| ${c.tcGroup} | ${c.band} | ${c.situation} | ${s.n} | ${s.clusters} | ${f1(s.q[0])} | ${f1(s.q[1])} | ${f1(s.q[2])} [${f1(s.ci.q[2]?.lo)}, ${f1(s.ci.q[2]?.hi)}] | ${f1(s.q[3])} | ${f1(s.q[4])} | ${pct(s.premove)} [${pct(s.ci.premove.lo)}, ${pct(s.ci.premove.hi)}] | ${pct(s.sub1)} |`
		);
	}
	return lines.join("\n");
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const file = flagValue(argv, "labels", PATHS.labels) ?? PATHS.labels;
	const cap = Number(flagValue(argv, "cap", "30"));
	const resamples = Number(flagValue(argv, "resamples", "200"));
	const out = flagValue(argv, "out");
	const acc = new HumanAccumulator(hasFlag(argv, "wide") ? wideBandOf : bandOf, cap);
	for await (const r of readJsonl<LabelRow>(file)) acc.add(r);
	const cells = acc.build(resamples);
	const situations = flagValue(argv, "situations")?.split(",") ?? [...SITUATIONS, "all"];
	const table = humanTable(cells.filter((c) => situations.includes(c.situation)));
	if (out) await Bun.write(out, `${JSON.stringify(cells)}\n`);
	console.log(`${acc.rows} rows (cap ${cap} game-sides per player per time class)\n`);
	console.log(table);
}

if (import.meta.main) await main();
