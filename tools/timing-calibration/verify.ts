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
 *
 * Parts: `verify/cells.ts` (cells, comparison, headline, table specs), `verify/tables.ts` (the
 * markdown tables), shared with `crossfit.ts`, `flags.ts`, `crawl-verify.ts` and
 * `premove-outcomes.ts`.
 */

import "../lib/defines";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { flagValue, hasFlag } from "../lib/cli";
import { bandOf, PATHS, wideBandOf } from "./common";
import { loadReplay, type SimOptions, simulate } from "./sim";
import { cellsOf, evaluate, headline, loadTable } from "./verify/cells";
import { cellTable, spendReport } from "./verify/tables";

export {
	type CellInput,
	type CellResult,
	cellsOf,
	evaluate,
	headline,
	loadTable,
} from "./verify/cells";
export { cellTable, f2, pct, spendReport } from "./verify/tables";

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
