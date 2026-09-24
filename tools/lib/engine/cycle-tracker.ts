/**
 * tools/lib/engine/cycle-tracker.ts — `uci-client.ts`'s strict MultiPV cycle rule for the tool-side
 * referee (`SearchSpec.captureDepths` / `strictCycles`): the per-depth side captures and the final
 * cycle the pipeline's `analysis.final` would hold. Nothing here runs in the extension.
 */

import { applyMoves, legalMoves } from "@core/chess/san";
import { type Info, parseInfo, type UciScore } from "@core/engine/uci-parser";
import type { CapturedCycle, RawLine, SearchSpec } from "./types";

/** `uci-client.ts`'s exact score order: winning mates, then cp, then losing mates. */
function compareUciScores(a: UciScore, b: UciScore): number {
	const tier = (score: UciScore): number => (score.type === "cp" ? 0 : score.value > 0 ? 1 : -1);
	const tierDifference = tier(b) - tier(a);
	if (tierDifference !== 0) return tierDifference;
	return a.type === "cp" ? b.value - a.value : a.value - b.value;
}

export interface CycleTracker {
	listen: (line: string) => void;
	captures: Record<number, CapturedCycle>;
	/** `completedFrame ?? partialFrame` of `uci-client.ts`. */
	final: () => { lines: RawLine[]; depth: number; complete: boolean } | undefined;
}

/**
 * The `captureDepths` listener: `Pending.captureFrame` of `src/core/engine/uci-client.ts`
 * transcribed — a cycle is `multipv` 1…K in order, one depth, exact scores in non-increasing
 * order, unique legal roots; it is complete at K = min(MultiPV, legal roots).
 */
export function cycleTracker(spec: SearchSpec): CycleTracker {
	const depths = [...new Set(spec.captureDepths ?? [])].sort((a, b) => a - b);
	const positionFen = spec.moves?.length ? applyMoves(spec.fen, spec.moves) : spec.fen;
	const restricted = spec.searchmoves?.length ? new Set(spec.searchmoves) : undefined;
	const legalRoots = new Set(
		(positionFen === null ? [] : legalMoves(positionFen)).filter(
			(move) => restricted === undefined || restricted.has(move)
		)
	);
	const expected = Math.min(spec.multiPv, legalRoots.size);
	const captures: Record<number, CapturedCycle> = {};
	let frame: Info[] = [];
	let completed: Info[] | undefined;
	let partial: Info[] | undefined;
	const depthOf = (cycle: Info[] | undefined): number => cycle?.[0]?.depth ?? 0;
	const listen = (line: string): void => {
		if (!line.startsWith("info")) return;
		const info = parseInfo(line);
		if (!info || info.string !== undefined) return;
		if (info.pv === undefined || info.depth === undefined || info.score === undefined) return;
		const k = info.multipv ?? 1;
		if (k === 1) frame = [];
		const previous = frame.at(-1);
		const root = info.pv[0];
		if (
			k !== frame.length + 1 ||
			k > expected ||
			info.score.bound !== undefined ||
			root === undefined ||
			!legalRoots.has(root) ||
			frame.some((l) => l.pv?.[0] === root) ||
			(previous !== undefined &&
				(previous.depth !== info.depth ||
					(previous.score !== undefined && compareUciScores(previous.score, info.score) > 0)))
		) {
			frame = [];
			return;
		}
		frame.push(info);
		if (frame.length !== expected) {
			if (
				partial === undefined ||
				info.depth > depthOf(partial) ||
				(info.depth === depthOf(partial) && frame.length >= partial.length)
			)
				partial = [...frame];
			return;
		}
		const depth = info.depth;
		if (depth >= depthOf(completed)) completed = [...frame];
		let cycle: CapturedCycle | undefined;
		for (const d of depths) {
			if (depth < d) break;
			const held = captures[d];
			if (held !== undefined && held.depth !== depth) continue;
			cycle ??= {
				depth,
				lines: frame.map((l) => ({
					uci: l.pv?.[0] ?? "",
					score: l.score?.type === "mate" ? { mate: l.score.value } : { cp: l.score?.value ?? 0 },
				})),
			};
			captures[d] = cycle;
		}
	};
	const toRaw = (info: Info): RawLine => {
		const raw: RawLine = {
			multipv: info.multipv ?? 1,
			depth: info.depth ?? 0,
			score: info.score?.type === "mate" ? { mate: info.score.value } : { cp: info.score?.value ?? 0 },
			pv: info.pv ?? [],
		};
		if (info.wdl) raw.wdl = info.wdl;
		return raw;
	};
	const final = () => {
		const cycle = completed ?? partial;
		if (cycle === undefined || cycle.length === 0) return undefined;
		return { lines: cycle.map(toRaw), depth: depthOf(cycle), complete: completed !== undefined };
	};
	return { listen, captures, final };
}
