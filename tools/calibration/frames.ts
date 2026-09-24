/**
 * tools/calibration/frames.ts — the referee (Stockfish) frame cache for the offline Maia
 * strength-calibration harness. Library + CLI.
 *
 * One JSON object per corpus row id in `data/calibration/frames.jsonl` (`FrameCacheRecord`),
 * searched the way `tools/human-match/replay.ts`'s `refereeFrame` mirrors the pipeline — the
 * vendored Stockfish 19 smallnet, one thread, 32 MB hash, `ucinewgame` before every search:
 *
 *   1. main MultiPV search: `go movetime SEARCH_BUDGET.moveMs[tc] depth automaticDepthForElo(bucket)`,
 *      MultiPV `breadthFor(bucket, legal)`; the same search also captures, for every depth d of
 *      the `HUMAN_DEPTH` range (2…14), the first complete MultiPV cycle at depth ≥ d — the rule
 *      `uci-client.ts` applies to the pipeline's human-depth frame (`analysis.atFeatureDepth`) —
 *      so the harness can read the frame for whatever Maia rating it conditions on;
 *   2. one extra `searchmoves` pass on Maia's favourites the main frame left unscored, pooled over
 *      **every** grid policy of the row (each policy gated by `maiaExtraSearchmoves`, up to
 *      `EXTRA_MAX_ROOTS` roots), merged with `mergeLines`;
 *   3. the human move's own single-root line when the pool still lacks it (`humanLine`, never in
 *      the pool).
 *
 * Usage
 *   bun tools/calibration/frames.ts [--corpus data/calibration/corpus.jsonl]
 *        [--policies data/calibration/policies.jsonl | --no-policies] [--require-policies]
 *        [--out data/calibration/frames.jsonl]
 *        [--workers 9] [--limit N] [--filter-split fit|holdout] [--filter-tc bullet,blitz]
 *        [--sample-per-cell K] [--seed S]
 *
 * Resumable: ids already in `--out` or in its `.parts/` directory are skipped; parts are merged
 * into `--out` at the end (and at the start of the next run, should one be interrupted).
 *
 * The parts live in `frames/`: the record schema, the search recipe, row selection, the on-disk
 * store, the worker process and the coordinator. This file is also the worker's entry
 * (`--worker <part file>`).
 */

import "../lib/defines";
import { parseArgs } from "./frames/args";
import { runCoordinator } from "./frames/coordinator";
import { runWorker } from "./frames/worker";

export { jsonlLines } from "../lib/jsonl";
export { hash32 } from "../lib/random";
export {
	breadthFor,
	CAPTURE_DEPTHS,
	computeFrame,
	createFrameEngine,
	EXTRA_MAX_ROOTS,
	gridExtraSearchmoves,
	MAIN_MOVETIME_MS,
	rowId,
} from "./frames/recipe";
export type {
	CalibrationRow,
	FrameCacheRecord,
	GridPolicy,
	PolicyRecord,
	ScoredRoot,
	TcClass,
} from "./frames/schema";

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	if (args.worker !== undefined) await runWorker(args.worker);
	else await runCoordinator(args, import.meta.path);
}
