/**
 * tools/calibration/rating-eval.ts — train the intrinsic rating model and measure its accuracy.
 *
 *   bun tools/calibration/rating-eval.ts --extract   # cells → data/calibration/moves.jsonl
 *   bun tools/calibration/rating-eval.ts --train [--train-split fit|holdout|all] [--model-out F]
 *       # the split's humans → F (default data/calibration/rating-model.json), and its accuracy on
 *       # the other split's humans → F with `-eval.md` (in-sample when trained on all)
 *
 * Accuracy is measured on the holdout players only, two ways:
 *   - **cell recovery**: each time class × bucket's pooled estimate from its humans' moves against
 *     their mean actual rating (bias, RMSE, and whether the 95 % interval covers it);
 *   - **per game**: a MAP estimate per (game, side) with a weak prior at the class mean, and the R²
 *     of actual rating on it — directly comparable with the first estimator's per-game R².
 *
 * The parts live in `rating-eval/`: the moves file and model set, the extraction, the per-game MAP
 * estimate and the training report.
 */

import "../lib/defines";
import { flagOr, hasFlag } from "../lib/cli";
import { trainAndEvaluate } from "./rating-eval/evaluate";
import { extract } from "./rating-eval/extract";
import { MODEL_FILE } from "./rating-eval/moves";

export {
	type HumanMove,
	loadModels,
	MODEL_FILE,
	MOVES_FILE,
	type ModelSet,
} from "./rating-eval/moves";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (hasFlag(argv, "extract")) await extract();
	if (hasFlag(argv, "train"))
		await trainAndEvaluate(flagOr(argv, "train-split", "fit"), flagOr(argv, "model-out", MODEL_FILE));
}

if (import.meta.main) await main();
