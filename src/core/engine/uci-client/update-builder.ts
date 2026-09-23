/**
 * Builds `AnalysisUpdate` frames for one request: lines ordered by multipv index, scores as
 * `Eval`, SAN memoised per PV over the searched position (the one the moves reach).
 */

import { pvToSan } from "@core/chess/san";
import type { EvalLine } from "@typedefs/engine";
import type { AnalysisUpdate } from "../types";
import type { Info } from "../uci-parser";
import { toEval } from "./score";

/** Search totals as they stand; spread into every update. */
export interface SearchTotals {
	nodes: number;
	nps: number;
	timeMs: number;
}

/**
 * Running totals. They may arrive without a PV, on an interim bound, or beside an older depth,
 * so every `info` line contributes: `nodes` / `timeMs` only grow, and `nps` follows the latest
 * report that is not older than the time already seen.
 */
export class SearchMetrics {
	readonly totals: SearchTotals = { nodes: 0, nps: 0, timeMs: 0 };

	absorb(info: Info): void {
		const totals = this.totals;
		if (info.nps !== undefined && (info.time === undefined || info.time >= totals.timeMs))
			totals.nps = info.nps;
		totals.nodes = Math.max(totals.nodes, info.nodes ?? 0);
		totals.timeMs = Math.max(totals.timeMs, info.time ?? 0);
	}
}

export class UpdateBuilder {
	private readonly sanMemo = new Map<string, string[]>();

	constructor(
		private readonly id: string,
		/** The searched position, or `null` when the request's moves do not replay. */
		private readonly positionFen: string | null,
		private readonly metrics: SearchMetrics
	) {}

	private san(pv: string[]): string[] {
		const key = pv.join(" ");
		const memo = this.sanMemo.get(key);
		if (memo) return memo;
		const out = this.positionFen === null ? [] : pvToSan(this.positionFen, pv);
		this.sanMemo.set(key, out);
		return out;
	}

	/**
	 * One frame over `entries` (multipv index → line). `seldepth` comes from the first line, else
	 * from `fallbackSeldepth` (the newest accepted line of the request).
	 */
	build(
		entries: ReadonlyMap<number, Info>,
		depth: number,
		complete: boolean,
		fallbackSeldepth: number | undefined
	): AnalysisUpdate {
		const lines: EvalLine[] = [...entries.entries()]
			.sort(([a], [b]) => a - b)
			.map(([multipv, info]) => {
				const pv = info.pv ?? [];
				const line: EvalLine = {
					multipv,
					score: info.score ? toEval(info.score) : {},
					depth: info.depth ?? 0,
					pvUci: pv,
					pvSan: this.san(pv),
				};
				if (info.seldepth !== undefined) line.seldepth = info.seldepth;
				if (info.wdl !== undefined) line.wdl = info.wdl;
				if (info.score?.bound !== undefined) line.bound = info.score.bound;
				return line;
			});
		const u: AnalysisUpdate = {
			id: this.id,
			depth,
			lines,
			...this.metrics.totals,
			complete,
		};
		const seldepth = entries.get(1)?.seldepth ?? fallbackSeldepth;
		if (seldepth !== undefined) u.seldepth = seldepth;
		return u;
	}
}
