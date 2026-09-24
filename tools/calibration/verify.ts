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
 *
 * The parts live in `verify/`: the arguments, one cell's verification (the worker), the
 * orchestrator and the report. This file is also the worker's entry.
 */

import "../lib/defines";
import { parseArgs } from "./verify/args";
import { verifyCell } from "./verify/cell";
import { verifyCells } from "./verify/orchestrate";
import { writeReport } from "./verify/report";

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.worker) return verifyCell(args);
	if (!args.reportOnly) await verifyCells(args, import.meta.path);
	await writeReport(args);
}

if (import.meta.main) await main();
