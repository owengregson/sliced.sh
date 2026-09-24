/**
 * Coherent MultiPV frames of one search. A UCI output cycle starts at multipv 1; prior cycles
 * never fill its missing slots. Only exact, same-depth, unique-root cycles in the engine's score
 * order are retained — the deepest complete one (what a recommendation gets), the best partial
 * one (its fallback), and the human frame at the requested feature depth.
 */

import { LIMITS } from "@core/constants/limits";
import type { AnalysisUpdate } from "../types";
import type { Info } from "../uci-parser";
import { compareScores } from "./score";

/** The timing model's fixed feature depth `D_f` (§6.5, Appendix D §2); lives in `LIMITS`. */
export const FEATURE_DEPTH: number = LIMITS.featureDepth;

/** Builds a frame over `entries` (multipv index → line) at `depth`. */
export type FrameBuilder = (
	entries: ReadonlyMap<number, Info>,
	depth: number,
	complete: boolean
) => AnalysisUpdate;

export class FrameCapture {
	private frame: Info[] = [];
	completed: AnalysisUpdate | undefined;
	partial: AnalysisUpdate | undefined;
	atFeatureDepth: AnalysisUpdate | undefined;

	constructor(
		private readonly legalRoots: ReadonlySet<string>,
		private readonly expectedMultiPv: number,
		private readonly featureDepth: number,
		private readonly build: FrameBuilder
	) {}

	capture(info: Info): void {
		if (info.pv === undefined || info.depth === undefined || info.score === undefined) return;
		const k = info.multipv ?? 1;
		if (k === 1) this.frame = [];
		const previous = this.frame.at(-1);
		const root = info.pv[0];
		if (
			k !== this.frame.length + 1 ||
			k > this.expectedMultiPv ||
			info.score.bound !== undefined ||
			root === undefined ||
			!this.legalRoots.has(root) ||
			this.frame.some((line) => line.pv?.[0] === root) ||
			(previous !== undefined &&
				(previous.depth !== info.depth ||
					(previous.score !== undefined && compareScores(previous.score, info.score) > 0)))
		) {
			this.frame = [];
			return;
		}
		this.frame.push(info);
		const complete = this.frame.length === this.expectedMultiPv;
		const captured = this.build(
			new Map(this.frame.map((line, index) => [index + 1, line])),
			info.depth,
			complete
		);
		if (complete) {
			if (captured.depth >= (this.completed?.depth ?? 0)) this.completed = captured;
			// H4 (2026-09-13): the *first* complete frame at or past the requested depth, refreshed
			// only while that same depth is re-emitted. A requested depth may never complete on its
			// own (a low MultiPV frame can be skipped by an aspiration re-search), in which case the
			// next depth that does is the human frame — never the deepest one that does not exceed it.
			if (
				captured.depth >= this.featureDepth &&
				(this.atFeatureDepth === undefined || this.atFeatureDepth.depth === captured.depth)
			)
				this.atFeatureDepth = captured;
		} else if (
			!this.partial ||
			captured.depth > this.partial.depth ||
			(captured.depth === this.partial.depth && captured.lines.length >= this.partial.lines.length)
		) {
			this.partial = captured;
		}
	}
}
