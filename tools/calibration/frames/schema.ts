/**
 * tools/calibration/frames/schema.ts — the records `frames.ts` reads and writes: the corpus row,
 * the Maia grid policies of `policies.jsonl`, and the cached referee frame of `frames.jsonl`.
 */

import type { EvalLine } from "@typedefs/engine";
import type { CorpusRow } from "../../human-match/replay";

export type TcClass = "bullet" | "blitz" | "rapid";

/** A `data/calibration/corpus.jsonl` row: replay.ts's `CorpusRow` plus the calibration keys. */
export interface CalibrationRow extends CorpusRow {
	tc: TcClass;
	/** chess.com rating bucket, 600…3000 step 200. */
	bucket: number;
	player?: string;
	color?: "w" | "b" | "white" | "black";
	split?: "fit" | "holdout";
}

/** One grid entry of `data/calibration/policies.jsonl`. */
export interface GridPolicy {
	selfElo: number;
	moves: Array<[string, number]>;
	wdl?: [number, number, number];
}

export interface PolicyRecord {
	id: string;
	policies: GridPolicy[];
}

export interface ScoredRoot {
	uci: string;
	score: EvalLine["score"];
}

export interface FrameCacheRecord {
	id: string;
	/**
	 * The merged scored pool: the main frame sorted by `compareLines`, then the extra pass's new
	 * roots (sorted by `compareLines` among themselves) — `mergeLines`'s order, which `rankedLines`
	 * relies on to pin the main frame's best line as the reference. `multipv` is renumbered 1…K.
	 */
	lines: EvalLine[];
	bestmove: string | null;
	/** Roots the extra `searchmoves` pass added to `lines`. */
	extra: string[];
	/** Depth of the main frame. */
	depth: number;
	/** Whether the main frame reported every requested root at `depth`. */
	complete: boolean;
	/**
	 * Requested depth d (2…14) → the first complete main-search cycle at depth ≥ d, roots in the
	 * engine's order. A depth the search never completed a cycle at or past is absent.
	 */
	byDepth: Record<number, ScoredRoot[]>;
	/** Requested depth d → the depth that cycle was actually reported at (≥ d). */
	byDepthAt: Record<number, number>;
	/** The human move's own line when the pool never scored it (baseline only, not in `lines`). */
	humanLine?: EvalLine;
	/** Wall-clock ms the row's searches took. */
	ms: number;
}
