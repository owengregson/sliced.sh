/**
 * tools/timing-calibration/fit.ts — fit the think-time calibration table.
 *
 *     bun tools/timing-calibration/fit.ts --stage premove                  # 1 replay → fit/premove.json
 *     bun tools/timing-calibration/fit.ts --stage shift --grid -1.2,-0.9,…  # replays → fit/shift-<g>.json
 *     bun tools/timing-calibration/fit.ts --stage table --source fit|holdout|all [--out FILE] [--write]
 *
 * The replay (`sim.ts`) runs the production configuration being fitted: the fast-reply search cap
 * and the anticipatory hover on. All selected sides of both splits are replayed in every run, and
 * each run's per-cell statistics are saved **per split**, so a table can be fitted from the fit
 * split, from the holdout split (the cross-fit) or from everyone (the shipped table) without
 * replaying again.
 *
 * **Premove.** How often a safe recapture is premoved is linear in the attempt probability `p`: a
 * premove needs an armed candidate (drawn with `p`), the reply the prediction named, and an
 * opponent think long enough to enter it. So one replay at `p = P0` measures the achievable share
 * per cell. The fitted `p = P0 · human share / bot share` is clamped to [0, 1] and smoothed
 * across rating (below), then made non-decreasing in rating (PAVA), because stronger players
 * premove more.
 *
 * **Shift.** One replay per grid value g, with every situation's shift set to g. For each cell
 * (time class × 400-Elo band × situation) the objective is
 * `n_eff · Σ_q w_q (ln bot_q − ln human_q)²` over the 10/25/50/75/90 % quantiles (weights
 * ½,1,1,1,½, `n_eff = min(human moves, N_EFF_MAX)`). A shift only moves its own cell's moves.
 * The per-game state it could leak through, the AR residual and the pace feedback, is shared
 * evenly, so the cells are fitted jointly by a Viterbi pass over the rating knots: the objective
 * plus `λ·(v_k − v_{k−1})²` between neighbouring knots, where the knots are the bands' centres.
 * Cells with fewer than `MIN_CELL` human moves contribute nothing, and the smoothness fills them.
 *
 * Parts: `fit/stages.ts` (the three stages), `fit/cells.ts` (a replay summarised per cell and
 * the objective), `fit/table.ts` (the premove and shift tables and their literal),
 * `fit/smoothing.ts` (the pure smoothers).
 */

import "../lib/defines";
import type { TimingCalibrationTimeClass } from "@core/constants/timing-calibration";
import { flagValue } from "../lib/cli";
import { stagePremove, stageShift, stageTable } from "./fit/stages";

export { KNOTS, P0 } from "./fit/cells";
export { isotonic, smoothWeighted, viterbi } from "./fit/smoothing";
export {
	fittedTable,
	PRIOR_SHIFT,
	premoveTable,
	SMOOTH_PREMOVE,
	SMOOTH_SHIFT,
	tableLiteral,
} from "./fit/table";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const stage = flagValue(argv, "stage");
	const chains = Number(flagValue(argv, "chains", "4"));
	if (stage === "premove") await stagePremove(chains);
	else if (stage === "shift")
		await stageShift(
			(flagValue(argv, "grid", "0") ?? "0").split(",").map(Number),
			Number(flagValue(argv, "power", "1")),
			chains,
			flagValue(argv, "only") as TimingCalibrationTimeClass | undefined
		);
	else if (stage === "table") await stageTable(argv);
	else throw new Error("fit: --stage premove|shift|table");
	process.exit(0);
}

if (import.meta.main) await main();
