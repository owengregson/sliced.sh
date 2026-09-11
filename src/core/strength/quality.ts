import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { SELECTION_CONSTANTS as C } from "./constants";

function scoreClass(line: EvalLine): number {
	if (Number.isFinite(line.score.mate)) return (line.score.mate ?? 0) > 0 ? 3 : 1;
	return Number.isFinite(line.score.cp) ? 2 : 0;
}

/** Raw engine ordering; normalising scores for policy must not collapse large advantages. */
export function compareLines(a: EvalLine, b: EvalLine): number {
	const group = scoreClass(b) - scoreClass(a);
	if (group !== 0) return group;
	if (a.score.mate !== undefined && b.score.mate !== undefined) return a.score.mate - b.score.mate;
	return (b.score.cp ?? 0) - (a.score.cp ?? 0);
}

/** One credible report per root move, with ranking anchored before any policy veto. */
export function rankedLines(lines: readonly EvalLine[]): EvalLine[] {
	const byMove = new Map<string, EvalLine>();
	for (const line of lines) {
		const move = line.pvUci[0];
		if (!move || line.bound !== undefined || scoreClass(line) === 0) continue;
		const existing = byMove.get(move);
		if (!existing || line.depth > existing.depth) byMove.set(move, line);
	}
	return [...byMove.values()].sort(compareLines);
}

export function moveQuality(
	lines: readonly EvalLine[],
	chosen: EvalLine | undefined
): { quality: NonNullable<ChosenMove["quality"]>; cpLoss?: number } {
	const reference = rankedLines(lines);
	const best = reference[0];
	const quality: NonNullable<ChosenMove["quality"]> = {
		kind: "search",
		eligible: false,
		depth: chosen?.depth ?? 0,
		candidates: reference.length,
	};
	if (chosen?.bound !== undefined) quality.reason = "bound";
	else if (!best || !chosen || scoreClass(chosen) === 0) quality.reason = "unknown";
	else if (best.score.mate !== undefined || chosen.score.mate !== undefined) quality.reason = "mate";
	else if (reference.length < 2) quality.reason = "forced";
	else if (Math.min(best.depth, chosen.depth) < C.quality.minDepth) quality.reason = "shallow";
	else if (best.depth !== chosen.depth) quality.reason = "depth-mismatch";
	else if (Number.isFinite(best.score.cp) && Number.isFinite(chosen.score.cp)) {
		quality.eligible = true;
		return { quality, cpLoss: Math.max(0, (best.score.cp ?? 0) - (chosen.score.cp ?? 0)) };
	} else quality.reason = "unknown";
	return { quality };
}
