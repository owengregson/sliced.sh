/**
 * tools/timing-calibration/common.ts — shared shapes, paths and cell keys for the think-time
 * calibration (`build-corpus.ts` → `heads.ts` / `frames.ts` → `sim.ts` → `fit.ts` / `verify.ts`).
 * Nothing here runs in the extension.
 *
 * Parts: `common/paths.ts` (the data directory), `common/corpus.ts` (the corpus, label and row
 * shapes), `common/bands.ts` (rating bands, time-control groups, thresholds). The JSONL reader
 * and writer are `tools/lib/jsonl.ts`.
 */

export { JsonlWriter, readJsonl } from "../lib/jsonl";
export {
	BAND_MAX,
	BAND_MIN,
	BAND_WIDTH,
	bandOf,
	LOW_CLOCK_FRACTION,
	LOW_CLOCK_MS,
	PREMOVE_MAX_MS,
	parseControl,
	TC_GROUPS,
	type TimeClass,
	tcGroupOf,
	wideBandOf,
} from "./common/bands";
export {
	type CorpusGame,
	type LabelRow,
	type PlyLabel,
	rowsOf,
	SITUATIONS,
	type SideInfo,
	type Situation,
	type Split,
	type TimingRow,
} from "./common/corpus";
export { DATA_DIR, PATHS } from "./common/paths";
