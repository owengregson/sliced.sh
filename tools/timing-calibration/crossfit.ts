/**
 * tools/timing-calibration/crossfit.ts — the calibration measured on players it was not fitted on,
 * both ways, plus the "before" baseline and the shipped all-player table.
 *
 *     bun tools/timing-calibration/crossfit.ts [--chains 4] [--resamples 200]
 *
 * It needs `fit/table-fit.json`, `fit/table-holdout.json` and `fit/table-all.json`
 * (`fit.ts --stage table --source …`). It runs these replays:
 *
 *   before           main before this change: the shipped band set's outputs, identity table,
 *                    no fast-reply cap, no anticipatory hover                    → holdout and fit
 *   new-head         the band set being calibrated, identity table, no cap, no hover → holdout
 *   fit → holdout    table fitted on the fit split, production config           → holdout
 *   holdout → fit    table fitted on the holdout split                          → fit
 *   all              table fitted on everyone (the shipped one)                  → holdout and fit
 *   mechanisms       identity table with the cap and the hover but no fitted values → holdout
 *
 * `verify/crossfit/report.md` holds the headline scores and the high-Elo book and recapture cells
 * of every run. The full tables go under `verify/crossfit/<run>.md`.
 */

import "../lib/defines";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { TIMING_CALIBRATION_IDENTITY } from "@core/constants/timing-calibration";
import { flagValue } from "../lib/cli";
import { bandOf, PATHS, wideBandOf } from "./common";
import { loadReplay, type SimOptions, simulate } from "./sim";
import {
	type CellResult,
	cellsOf,
	cellTable,
	evaluate,
	headline,
	loadTable,
	spendReport,
} from "./verify";

interface Run {
	name: string;
	table: string;
	production: boolean;
	split: "fit" | "holdout";
	/**
	 * The head outputs replayed: `"shipped"` the band set on main before this change (the
	 * `heads.jsonl` cache), else `SL_HEADS_TAG`'s (the band set being calibrated).
	 */
	heads?: "shipped";
}

const RUNS: Run[] = [
	{
		name: "before-holdout",
		table: "identity",
		production: false,
		split: "holdout",
		heads: "shipped",
	},
	{ name: "before-fit", table: "identity", production: false, split: "fit", heads: "shipped" },
	{ name: "new-head-holdout", table: "identity", production: false, split: "holdout" },
	{ name: "mechanisms-holdout", table: "identity", production: true, split: "holdout" },
	{
		name: "fit-to-holdout",
		table: path.join(PATHS.fit, "table-fit.json"),
		production: true,
		split: "holdout",
	},
	{
		name: "holdout-to-fit",
		table: path.join(PATHS.fit, "table-holdout.json"),
		production: true,
		split: "fit",
	},
	{
		name: "all-holdout",
		table: path.join(PATHS.fit, "table-all.json"),
		production: true,
		split: "holdout",
	},
	{ name: "all-fit", table: path.join(PATHS.fit, "table-all.json"), production: true, split: "fit" },
];

const HIGH = (c: CellResult) =>
	(c.tcGroup === "bullet" || c.tcGroup === "blitz") &&
	c.band >= 2200 &&
	["book", "recapture", "all"].includes(c.situation);

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const chains = Number(flagValue(argv, "chains", "4"));
	const resamples = Number(flagValue(argv, "resamples", "200"));
	const only = flagValue(argv, "runs")?.split(",");
	const current = await loadReplay();
	const shippedTag = process.env.SL_HEADS_TAG ? await loadReplay({ headsTag: "" }) : current;
	const dir = path.join(PATHS.verify, "crossfit");
	mkdirSync(dir, { recursive: true });
	const summary: Record<string, unknown> = {};
	const lines = ["# timing calibration: cross-fit", ""];
	for (const run of RUNS) {
		if (only && !only.includes(run.name)) continue;
		const table = run.table === "identity" ? TIMING_CALIBRATION_IDENTITY : await loadTable(run.table);
		const opts: SimOptions = {
			table,
			fastReply: run.production,
			hover: run.production,
			chains,
			seed: "crossfit",
		};
		const t0 = performance.now();
		const data = run.heads === "shipped" ? shippedTag : current;
		const results = await simulate(data, opts, (s) => s.split === run.split);
		const wide = evaluate(cellsOf(data, results, run.split, wideBandOf), resamples);
		const fine = evaluate(cellsOf(data, results, run.split, bandOf), resamples).filter(HIGH);
		const head = headline(wide);
		summary[run.name] = { headline: head, wide, fine };
		const body = [
			`# ${run.name}`,
			"",
			`table ${run.table}; production ${run.production}; split ${run.split}; ${chains} chains; ${((performance.now() - t0) / 1000).toFixed(0)} s`,
			"",
			"```",
			JSON.stringify(head, null, 1),
			"```",
			"",
			spendReport(data, results, run.split),
			"",
			cellTable(wide),
			"",
			"## 100-Elo, bullet/blitz 2200+",
			"",
			cellTable(fine),
			"",
		].join("\n");
		await Bun.write(path.join(dir, `${run.name}.md`), body);
		lines.push(
			`## ${run.name}`,
			"",
			"```",
			JSON.stringify(head),
			"```",
			"",
			cellTable(wide.filter(HIGH)),
			""
		);
		console.log(`${run.name}: ${JSON.stringify(head)}`);
	}
	await Bun.write(path.join(dir, "report.md"), lines.join("\n"));
	await Bun.write(path.join(dir, "summary.json"), `${JSON.stringify(summary)}\n`);
	process.exit(0);
}

if (import.meta.main) await main();
