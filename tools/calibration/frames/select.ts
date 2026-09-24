/**
 * tools/calibration/frames/select.ts — which corpus rows a run searches: the split and time-class
 * filters, a deterministic per-cell subsample (FNV-1a of seed and id), then the limit.
 */

import { jsonlLines } from "../../lib/jsonl";
import { hash32 } from "../../lib/random";
import type { FramesArgs } from "./args";
import { rowId } from "./recipe";
import type { CalibrationRow } from "./schema";

export async function selectRows(
	args: Pick<FramesArgs, "corpus" | "filterSplit" | "filterTc" | "samplePerCell" | "seed" | "limit">
): Promise<Array<{ id: string; row: CalibrationRow }>> {
	let rows: Array<{ id: string; row: CalibrationRow }> = [];
	let index = 0;
	for await (const line of jsonlLines(args.corpus)) {
		const row = JSON.parse(line) as CalibrationRow;
		const id = rowId(row, index++);
		if (args.filterSplit !== undefined && row.split !== args.filterSplit) continue;
		if (args.filterTc !== undefined && !args.filterTc.has(row.tc)) continue;
		rows.push({ id, row });
	}
	if (args.samplePerCell > 0) {
		const cells = new Map<string, Array<{ id: string; row: CalibrationRow }>>();
		for (const r of rows) {
			const key = `${r.row.tc}:${r.row.bucket}`;
			const list = cells.get(key) ?? [];
			list.push(r);
			cells.set(key, list);
		}
		rows = [];
		for (const list of cells.values()) {
			list.sort(
				(a, b) =>
					hash32(`${args.seed}:${a.id}`) - hash32(`${args.seed}:${b.id}`) || (a.id < b.id ? -1 : 1)
			);
			rows.push(...list.slice(0, args.samplePerCell));
		}
	}
	if (args.limit > 0) rows = rows.slice(0, args.limit);
	return rows;
}
