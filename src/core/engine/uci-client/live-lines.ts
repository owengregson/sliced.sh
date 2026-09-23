/**
 * The live view of a search: the latest usable line per multipv index at the current
 * iteration depth. Lines of a deeper iteration start a new one; an older depth, a PV-less or
 * `string` report and a primary-line interim bound are ignored, and an exact score at a depth is
 * never replaced by a bound at the same depth.
 */

import { type Info, isInterimBoundLine } from "../uci-parser";

/** What one `info` did to the live view. */
export type LiveLineChange = "ignored" | "completed" | "updated";

export class LiveLines {
	readonly latest = new Map<number, Info>();
	/** The newest accepted line (its `seldepth` stands in when the first line has none). */
	last: Info | undefined;
	depth = 0;
	private readonly seen = new Set<number>();

	constructor(private readonly expectedMultiPv: number) {}

	/** Every expected multipv index has reported at the current iteration depth. */
	get complete(): boolean {
		if (this.expectedMultiPv === 0) return false;
		for (let k = 1; k <= this.expectedMultiPv; k++) if (!this.seen.has(k)) return false;
		return true;
	}

	/** `completed` exactly when this line is the one that completes the iteration. */
	accept(info: Info): LiveLineChange {
		if (
			info.string !== undefined ||
			info.pv === undefined ||
			info.depth === undefined ||
			info.score === undefined ||
			isInterimBoundLine(info)
		)
			return "ignored";
		const k = info.multipv ?? 1;
		if (info.depth < this.depth) return "ignored";
		if (info.depth > this.depth) {
			this.depth = info.depth;
			this.seen.clear();
		}
		const prev = this.latest.get(k);
		if (
			prev?.depth === info.depth &&
			prev.score?.bound === undefined &&
			info.score.bound !== undefined
		)
			return "ignored";
		this.latest.set(k, info);
		this.last = info;
		const wasComplete = this.complete;
		this.seen.add(k);
		return this.complete && !wasComplete ? "completed" : "updated";
	}
}
