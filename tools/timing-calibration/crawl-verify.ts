/**
 * tools/timing-calibration/crawl-verify.ts: an independent held-out check of the shipped table on
 * the big crawl, before vs after.
 *
 *     SL_TIMING_CALIB_DIR=data/timing/calib/crawl-holdout bun tools/timing-calibration/crawl-verify.ts
 *
 * It runs on the sample `select_crawl.py` wrote: holdout, kept crawl sides whose players are not
 * in the calibration corpus. The table was fitted on that corpus, so these players are new to it.
 * It needs two head caches in that directory:
 *
 *   heads.main.jsonl   main's band set (e2e3775: the upstream 2200–3500 band, its scalers), history row
 *   heads.cand.jsonl   the shipped fine-tuned band, timed-move row
 *
 * Two runs:
 *
 *   before   main's behaviour: main's band, identity table, no fast-reply cap, no hover
 *   after    the shipped table, the fine-tuned band, the fast-reply cap and the hover
 *
 * Output goes to `verify/crawl-holdout/`: `report.md` (headline, 100-Elo table per tc × band for
 * book / recapture / ordinary / all, and the full quantile tables) and `summary.json`.
 */

import "../lib/defines";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
	TIMING_CALIBRATION,
	TIMING_CALIBRATION_IDENTITY,
} from "@core/constants/timing-calibration";
import { flagValue } from "../lib/cli";
import { ROOT } from "../lib/paths";
import { bandOf } from "./common";
import { loadReplay, simulate } from "./sim";
import { type CellResult, cellsOf, cellTable, evaluate, headline } from "./verify";

const SITUATIONS = ["book", "recapture", "ordinary", "all"];

function medianTable(before: CellResult[], after: CellResult[]): string {
	const key = (c: CellResult) => `${c.tcGroup}|${c.band}|${c.situation}`;
	const b = new Map(before.map((c) => [key(c), c]));
	const f2 = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v.toFixed(2) : "–");
	const pct = (v: number | undefined) =>
		v !== undefined && Number.isFinite(v) ? `${Math.round(100 * v)}%` : "–";
	const lines = [
		"| tc | band | situation | n | median human / before / after (s) | after 95% CI | premove ≤0.2 s human / before / after | < 1 s human / before / after | AUC before / after |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	for (const a of after) {
		if (!SITUATIONS.includes(a.situation)) continue;
		const x = b.get(key(a));
		const h = a.cmp.human;
		lines.push(
			`| ${a.tcGroup} | ${a.band} | ${a.situation} | ${h.n} | ${f2(h.q[2])} / ${f2(x?.cmp.bot.q[2])} / ${f2(a.cmp.bot.q[2])} | [${f2(a.cmp.bot.ci.q[2]?.lo)}, ${f2(a.cmp.bot.ci.q[2]?.hi)}] | ${pct(h.premove)} / ${pct(x?.cmp.bot.premove)} / ${pct(a.cmp.bot.premove)} | ${pct(h.sub1)} / ${pct(x?.cmp.bot.sub1)} / ${pct(a.cmp.bot.sub1)} | ${f2(x?.cmp.auc)} / ${f2(a.cmp.auc)} |`
		);
	}
	return lines.join("\n");
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const chains = Number(flagValue(argv, "chains", "4"));
	const resamples = Number(flagValue(argv, "resamples", "200"));
	const out =
		flagValue(argv, "out", path.join(ROOT, "data/timing/calib/verify/crawl-holdout")) ?? "";
	const main = await loadReplay({ headsTag: "main" });
	const cand = await loadReplay({ headsTag: "cand" });
	const before = await simulate(main, {
		table: TIMING_CALIBRATION_IDENTITY,
		fastReply: false,
		hover: false,
		chains,
		seed: "crawl-holdout",
	});
	const after = await simulate(cand, {
		table: TIMING_CALIBRATION,
		fastReply: true,
		hover: true,
		chains,
		seed: "crawl-holdout",
	});
	const b = evaluate(cellsOf(main, before, "all", bandOf), resamples);
	const a = evaluate(cellsOf(cand, after, "all", bandOf), resamples);
	const situationsOnly = (cs: CellResult[]) => cs.filter((c) => c.situation !== "all");
	const rows = cand.sides.reduce((n, s) => n + s.rows.length, 0);
	const report = [
		"# timing calibration: independent crawl holdout",
		"",
		`${cand.sides.length} holdout sides (${rows} moves), players absent from the calibration corpus; ${chains} chains; 100-Elo bands`,
		"",
		"| run | cells | mean abs(AUC − ½) | KS | mean abs(ln median ratio) | mean abs(premove share diff) |",
		"|---|---|---|---|---|---|",
		...[
			["before", headline(b)],
			["after", headline(a)],
		].map(([name, h]) => {
			const x = h as Record<string, number>;
			return `| ${name} | ${x.cells} | ${x.aucDev?.toFixed(3)} | ${x.ks?.toFixed(3)} | ${x.logMedianErr?.toFixed(3)} | ${x.premoveErr?.toFixed(3)} |`;
		}),
		"",
		"## Medians and premove shares",
		"",
		medianTable(b, a),
		"",
		"## after: full quantiles",
		"",
		cellTable(a),
		"",
		"## before: full quantiles",
		"",
		cellTable(b),
		"",
	].join("\n");
	mkdirSync(out, { recursive: true });
	await Bun.write(path.join(out, "report.md"), report);
	await Bun.write(
		path.join(out, "summary.json"),
		`${JSON.stringify({ before: b, after: a, headline: { before: headline(situationsOnly(b)), after: headline(situationsOnly(a)) } })}\n`
	);
	console.log(report.split("## after")[0]);
	process.exit(0);
}

await main();
