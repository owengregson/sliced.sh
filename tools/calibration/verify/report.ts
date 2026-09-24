/**
 * tools/calibration/verify/report.ts — a label's verified cells as `report.md` (per time class: the
 * error profile with 95 % intervals and z, blunder and mistake rates by clock quartile, the
 * intrinsic rating verdict) and `summary.json` (what `crossfit.ts` pools).
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { MAIA_CALIBRATION_TIME_CLASSES } from "@core/constants/maia-calibration";
import { VERIFY_DIR } from "../common";
import { CLOCK_BINS, METRICS, type Metric, zScore } from "../stats";
import type { VerifyArgs } from "./args";
import type { CellResult } from "./cell";

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

/** Every verified cell of the label: `report.md` (also printed) and `summary.json`. */
export async function writeReport(args: VerifyArgs): Promise<void> {
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
