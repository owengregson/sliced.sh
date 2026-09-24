/**
 * tools/move-review/collect/plan.ts — which positions a collection mode searches.
 *
 *   labelled  the three positions a labelled verdict needs (before the opponent's last move,
 *             before the move, after it);
 *   marked    the same around every brilliant **and** every other chess.com mark;
 *   all       every position (for over-calling);
 *   list      exactly the `game:index` positions a file names (re-checking a sample);
 *   accept    `game:index:capture` lines — the position after move `index`, only `capture`
 *             searched (the opponent taking the offered piece).
 */

import { type BenchmarkGame, brilliantPlies } from "../evidence";

export const COLLECT_MODES = ["labelled", "marked", "all", "list", "accept"] as const;
export type CollectMode = (typeof COLLECT_MODES)[number];

export function isCollectMode(mode: string): mode is CollectMode {
	return (COLLECT_MODES as readonly string[]).includes(mode);
}

export interface AcceptProbe {
	index: number;
	capture: string;
}

/** A `--list` file: `game:index` rows (`list`) or `game:index:capture` rows (`accept`). */
export interface PositionList {
	listed: Map<number, number[]>;
	accepts: Map<number, AcceptProbe[]>;
}

export function parsePositionList(text: string, mode: CollectMode): PositionList {
	const listed = new Map<number, number[]>();
	const accepts = new Map<number, AcceptProbe[]>();
	for (const row of text.split("\n")) {
		const [gameText, indexText, capture] = row.trim().split(":");
		const game = Number(gameText);
		const index = Number(indexText);
		if (!Number.isInteger(game) || !Number.isInteger(index)) continue;
		if (mode === "accept" && capture)
			accepts.set(game, [...(accepts.get(game) ?? []), { index, capture }]);
		else listed.set(game, [...(listed.get(game) ?? []), index]);
	}
	return { listed, accepts };
}

/**
 * The positions to search in one game, ascending. Position `index` is the one before move `index`
 * (0-based); a labelled move is `ply - 1`. `accept` searches none of these (its probes are apart).
 */
export function positionsToSearch(
	mode: CollectMode,
	entry: BenchmarkGame,
	moveCount: number,
	listed: readonly number[] | undefined
): number[] {
	if (mode === "accept") return [];
	const plies =
		mode === "marked"
			? [...new Set([...brilliantPlies(entry), ...Object.keys(entry.labels ?? {}).map(Number)])]
			: brilliantPlies(entry);
	const around = plies.flatMap((ply) => [ply - 2, ply - 1, ply]);
	return mode === "all"
		? Array.from({ length: moveCount + 1 }, (_, i) => i)
		: [...new Set(mode === "list" ? (listed ?? []) : around)]
				.filter((i) => i >= 0 && i <= moveCount)
				.sort((a, b) => a - b);
}
