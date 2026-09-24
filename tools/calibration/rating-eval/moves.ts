/**
 * tools/calibration/rating-eval/moves.ts — the files and shapes the rating model is trained from and
 * written to: `moves.jsonl` (one judged human move per line) and the per-time-class model set.
 */

import path from "node:path";
import { DATA_DIR } from "../common";
import { covariates, type ModelMove, type RatingModel } from "../rating-model";
import type { PositionShape } from "../sim";

export const MOVES_FILE = path.join(DATA_DIR, "moves.jsonl");
export const MODEL_FILE = path.join(DATA_DIR, "rating-model.json");

/** One human move as the model reads it. */
export interface HumanMove {
	tc: string;
	bucket: number;
	split: string;
	rating: number;
	game: string;
	clockFrac: number;
	shape: PositionShape;
	y: number;
}

export type ModelSet = Record<string, RatingModel>;

export async function loadModels(file = MODEL_FILE): Promise<ModelSet> {
	return (await Bun.file(file).json()) as ModelSet;
}

export const toModelMove = (m: HumanMove): ModelMove => ({
	x: covariates(m.shape, m.clockFrac),
	y: m.y,
	cluster: m.game,
});
