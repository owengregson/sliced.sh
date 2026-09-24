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
 *
 * The parts live in `fit/`: the arguments, one cell's surface (the worker), the orchestrator, the
 * smoothing pass and the table outputs. This file is also the worker's entry.
 */

import "../lib/defines";
import { parseArgs } from "./fit/args";
import { orchestrate } from "./fit/orchestrate";
import { fitCell } from "./fit/surface";
import { writeSmoothed } from "./fit/table";

export { loadCell } from "./cells";
export { FIT_DIR } from "./fit/args";
export { JOINT, type Pick, smoothClass } from "./fit/smooth";
export { type CellSurface, flatTable, type SurfacePoint } from "./fit/surface";
export { tableSource } from "./fit/table";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	if (args.worker) await fitCell(args);
	else if (args.smooth) await writeSmoothed(args);
	else await orchestrate(args, import.meta.path);
}

if (import.meta.main) await main();
