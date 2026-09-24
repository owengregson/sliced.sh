/**
 * tools/calibration/build-corpus/summary.ts — the sides / positions tally per (time class, bucket,
 * split) that `corpus-summary.json` stores and the console table prints.
 */

import type { TimeClass } from "../common";
import type { Split } from "./rows";

export interface SummaryCell {
	tc: TimeClass;
	bucket: number;
	split: Split;
	sides: number;
	positions: number;
}

export class CorpusTally {
	readonly cells = new Map<string, SummaryCell>();

	/** One sampled side that yielded `positions` rows. */
	add(tc: TimeClass, bucket: number, split: Split, positions: number): void {
		const key = `${tc}:${bucket}:${split}`;
		const cell = this.cells.get(key) ?? { tc, bucket, split, sides: 0, positions: 0 };
		cell.sides++;
		cell.positions += positions;
		this.cells.set(key, cell);
	}

	/** The cells by time class, bucket, then split. */
	table(): SummaryCell[] {
		return [...this.cells.values()].sort(
			(a, b) => a.tc.localeCompare(b.tc) || a.bucket - b.bucket || a.split.localeCompare(b.split)
		);
	}

	/** The fit / holdout columns per (time class, bucket), in `table`'s order. */
	lines(): string[] {
		const table = this.table();
		const out = ["tc      bucket   fit sides/pos     holdout sides/pos"];
		const tcs = [...new Set(table.map((c) => c.tc))];
		for (const tc of tcs) {
			const buckets = [...new Set(table.filter((c) => c.tc === tc).map((c) => c.bucket))];
			for (const b of buckets) {
				const f = this.cells.get(`${tc}:${b}:fit`);
				const h = this.cells.get(`${tc}:${b}:holdout`);
				const fmt = (c: SummaryCell | undefined): string =>
					`${String(c?.sides ?? 0).padStart(5)} / ${String(c?.positions ?? 0).padEnd(7)}`;
				out.push(`${tc.padEnd(7)} ${String(b).padStart(6)}   ${fmt(f)}   ${fmt(h)}`);
			}
		}
		return out;
	}
}
