import { SEARCH_BUDGET } from "@core/constants/search";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import { SELECTION_CONSTANTS as C } from "./constants";

function scoreClass(line: EvalLine): number {
	if (Number.isFinite(line.score.mate)) return (line.score.mate ?? 0) > 0 ? 3 : 1;
	return Number.isFinite(line.score.cp) ? 2 : 0;
}

/**
 * Raw engine ordering **within one search frame**: winning mates (shortest first), then
 * centipawns, then losing mates (longest first). Depth-blind, because every line of one frame is
 * at the same depth. Normalising scores for policy must not collapse large advantages.
 *
 * Consumers (2026-09-13, §7 A1 of `docs/research/human-move-selection-ideas-2026-09-13.md`):
 * the selector's own sort of the usable pool (`move-selector.ts` `ranked`), the quality tests,
 * and `rankedLines`' choice of the reference line *inside* the primary frame. The pipeline's
 * `mergeLines` does **not** sort with it any more — the main frame stays first, the extra frame
 * is appended.
 */
export function compareLines(a: EvalLine, b: EvalLine): number {
	const group = scoreClass(b) - scoreClass(a);
	if (group !== 0) return group;
	if (a.score.mate !== undefined && b.score.mate !== undefined) return a.score.mate - b.score.mate;
	return (b.score.cp ?? 0) - (a.score.cp ?? 0);
}

/**
 * `compareLines` for a pool that **mixes frames** (the merged referee pool: the main MultiPV
 * frame plus the extra `searchmoves` frame on Maia's unscored favourites, one to three plies
 * shallower). Two centipawn lines from different depths whose scores are within
 * `SEARCH_BUDGET.mergeTieCp` are a tie broken towards the deeper line — a shallow search's
 * optimism is not a better score. Outside the band the scores order the lines; mate classes and
 * same-depth lines are exactly `compareLines`.
 *
 * Consumer: `rankedLines`, for every rank *below* the reference. The reference itself is pinned
 * (see there), so this comparator never decides rank 1.
 */
export function compareLinesForMerge(a: EvalLine, b: EvalLine): number {
	const group = scoreClass(b) - scoreClass(a);
	if (group !== 0) return group;
	if (a.score.mate !== undefined && b.score.mate !== undefined) return a.score.mate - b.score.mate;
	const cpA = a.score.cp ?? 0;
	const cpB = b.score.cp ?? 0;
	if (a.depth !== b.depth && Math.abs(cpA - cpB) <= SEARCH_BUDGET.mergeTieCp)
		return b.depth - a.depth;
	return cpB - cpA;
}

/**
 * One credible report per root move, with ranking anchored before any policy veto.
 *
 * The **reference** (rank 1, the line `moveQuality` measures loss against and the selector takes
 * `topCpRaw` from) is the best line of the **primary frame** — the frame the first usable input
 * line belongs to, i.e. the main referee frame after `mergeLines`, which always puts it first.
 * A line from another frame (the extra `searchmoves` frame) can outrank it only by score *class*
 * (a searched mate is a mate whichever search found it), never by centipawns: a 260 ms search
 * that has not yet seen the refutation must not inflate every other candidate's loss
 * (§7 A1, 2026-09-13). Every other rank is `compareLinesForMerge`. A single-frame pool orders
 * exactly as before.
 */
export function rankedLines(lines: readonly EvalLine[]): EvalLine[] {
	const byMove = new Map<string, EvalLine>();
	let primaryDepth: number | undefined;
	for (const line of lines) {
		const move = line.pvUci[0];
		if (!move || line.bound !== undefined || scoreClass(line) === 0) continue;
		primaryDepth ??= line.depth;
		const existing = byMove.get(move);
		if (!existing || line.depth > existing.depth) byMove.set(move, line);
	}
	const credible = [...byMove.values()];
	let reference: EvalLine | undefined;
	for (const line of credible) {
		if (line.depth !== primaryDepth) continue;
		if (reference === undefined || compareLines(line, reference) < 0) reference = line;
	}
	return credible.sort((a, b) => {
		const group = scoreClass(b) - scoreClass(a);
		if (group !== 0) return group;
		if (a === reference) return -1;
		if (b === reference) return 1;
		return compareLinesForMerge(a, b);
	});
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
	// §7 A2 (2026-09-13): the extra referee frame is a few plies shallower than the main one; a
	// difference inside `qualityDepthTolerance` (both past `minDepth`) is still a comparable sample.
	else if (Math.abs(best.depth - chosen.depth) > SEARCH_BUDGET.qualityDepthTolerance)
		quality.reason = "depth-mismatch";
	else if (Number.isFinite(best.score.cp) && Number.isFinite(chosen.score.cp)) {
		quality.eligible = true;
		return { quality, cpLoss: Math.max(0, (best.score.cp ?? 0) - (chosen.score.cp ?? 0)) };
	} else quality.reason = "unknown";
	return { quality };
}
