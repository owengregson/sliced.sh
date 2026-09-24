/**
 * tools/calibration/cells.ts — the per-cell files `shard.ts` writes and `fit.ts`, `verify.ts` and
 * `rating-eval.ts` read: `data/calibration/cells/<tc>-<bucket>.jsonl`, one `CellItem` per line.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { jsonlLines } from "../lib/jsonl";
import { DATA_DIR } from "./common";
import type { CellItem } from "./sim";

export const CELLS_DIR = path.join(DATA_DIR, "cells");

export function cellFile(dir: string, tc: string, bucket: number): string {
	return path.join(dir, `${tc}-${bucket}.jsonl`);
}

/** The cells in `dir` as `tc:bucket`, in directory order. */
export function cellsInDir(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => /^(bullet|blitz|rapid)-\d+\.jsonl$/.test(f))
		.map((f) => f.replace(/\.jsonl$/, "").replace("-", ":"));
}

/** A cell's items, the named split only (`all` or none: every item). */
export async function loadCell(
	file: string,
	split?: "fit" | "holdout" | "all"
): Promise<CellItem[]> {
	const items: CellItem[] = [];
	for await (const line of jsonlLines(file)) {
		const item = JSON.parse(line) as CellItem;
		if (split === undefined || split === "all" || item.row.split === split) items.push(item);
	}
	return items;
}
