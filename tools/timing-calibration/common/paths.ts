/**
 * tools/timing-calibration/common/paths.ts — where the calibration reads and writes. Everything
 * lives under `data/timing/calib/` (git-ignored) unless `SL_TIMING_CALIB_DIR` names another
 * directory (the crawl holdout uses one).
 */

import path from "node:path";
import { ROOT } from "../../lib/paths";

export const DATA_DIR = process.env.SL_TIMING_CALIB_DIR ?? path.join(ROOT, "data/timing/calib");

export const PATHS = {
	/** The default game source: the Maia calibration crawl (chess.com, `[%clk]` per ply). */
	games: path.join(ROOT, "data/calibration/games.jsonl"),
	/** The big timing crawl, once it is large enough (`data/timing/crawl/`). */
	crawlGames: path.join(ROOT, "data/timing/crawl/games.jsonl"),
	corpus: path.join(DATA_DIR, "corpus.jsonl"),
	/** The replayed games only, with FENs (`build_corpus.py --only select.json`). */
	selectGames: path.join(DATA_DIR, "select-games.jsonl"),
	labels: path.join(DATA_DIR, "labels.jsonl"),
	summary: path.join(DATA_DIR, "corpus-summary.json"),
	heads: path.join(DATA_DIR, "heads.jsonl"),
	frames: path.join(DATA_DIR, "frames.jsonl"),
	replay: path.join(DATA_DIR, "replay.jsonl"),
	sim: path.join(DATA_DIR, "sim"),
	fit: path.join(DATA_DIR, "fit"),
	verify: path.join(DATA_DIR, "verify"),
} as const;
