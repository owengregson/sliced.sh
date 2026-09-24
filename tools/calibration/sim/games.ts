/**
 * tools/calibration/sim/games.ts — a cell's rows grouped into (game, side) in ply order, each row
 * with its judge, its policy grid, the frame's scored lines, the human's outcome and the human's
 * previous own moves.
 */

import type { EvalLine } from "@typedefs/engine";
import type { CalibrationRow, FrameCacheRecord, GridPolicy } from "../frames/schema";
import { type Judge, judgeFor, type MoveOutcome, positionFacts } from "./judge";
import { PolicyGrid } from "./policy-grid";

/** A row with everything the simulation needs, as `shard.ts` writes it. */
export interface CellItem {
	row: CalibrationRow & { player?: string; split?: "fit" | "holdout" };
	frame: FrameCacheRecord;
	policies: GridPolicy[];
}

/** One (game, side): its rows in ply order and the per-row derived inputs. */
export interface Game {
	key: string;
	player: string;
	items: Array<{
		item: CellItem;
		judge: Judge;
		grid: PolicyGrid;
		lines: EvalLine[];
		human: MoveOutcome | null;
		/** The human's own previous moves (oldest first), for `previousOwnMoves`. */
		prevOwn: string[];
	}>;
}

export function groupGames(items: readonly CellItem[]): Game[] {
	const byKey = new Map<string, CellItem[]>();
	for (const it of items) {
		const key = `${it.row.gameId ?? it.row.id}:${it.row.color ?? ""}`;
		const list = byKey.get(key) ?? [];
		list.push(it);
		byKey.set(key, list);
	}
	const games: Game[] = [];
	for (const [key, list] of byKey) {
		list.sort((a, b) => a.row.ply - b.row.ply);
		const own: string[] = [];
		games.push({
			key,
			player: list[0]?.row.player ?? key,
			items: list.map((item) => {
				const judge = judgeFor(item.frame);
				Object.assign(judge.shape, positionFacts(item.row.fen));
				const entry = {
					item,
					judge,
					grid: new PolicyGrid(item.policies),
					lines: item.frame.lines.filter((l) => l.pvUci[0] !== undefined && l.pvUci[0] !== ""),
					human: judge.outcome(item.row.humanMove),
					prevOwn: [...own],
				};
				if (item.row.prevOwnMove !== undefined && own.at(-1) !== item.row.prevOwnMove)
					own.push(item.row.prevOwnMove);
				own.push(item.row.humanMove);
				return entry;
			}),
		});
	}
	games.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return games;
}
