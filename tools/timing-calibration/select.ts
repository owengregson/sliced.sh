/**
 * tools/timing-calibration/select.ts — which game-sides the bot replays.
 *
 *     bun tools/timing-calibration/select.ts [--per-cell 60] [--per-cell-high 120] [--per-player 3]
 *
 * Per (time-control group × wide rating band × split): up to `--per-cell` game-sides (bullet and
 * blitz from 2200: `--per-cell-high`, the cells the owner's complaint is about), at most
 * `--per-player` per player so one prolific account cannot carry a cell, chosen by a hash of the
 * game id (stable across runs). Writes `select.json`: the game-sides and the set of games whose
 * every ply `frames.ts` must search (the opponent's positions feed the ponder and premove
 * predictions).
 */

import "../lib/defines";
import path from "node:path";
import { flagValue } from "../lib/cli";
import { type CorpusGame, DATA_DIR, PATHS, readJsonl, tcGroupOf, wideBandOf } from "./common";
import { loadFrames } from "./frames";
import { hash32 } from "./stats";

export interface Selection {
	sides: Array<{ gameId: string; color: "w" | "b"; split: string; cell: string }>;
	games: string[];
}

export const SELECT_PATH = path.join(DATA_DIR, "select.json");

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const perCell = Number(flagValue(argv, "per-cell", "60"));
	const perCellHigh = Number(flagValue(argv, "per-cell-high", "120"));
	const perPlayer = Number(flagValue(argv, "per-player", "3"));
	// Games already searched (`frames.ts`) are preferred, so a re-selection on a bigger corpus
	// reuses the engine work; within each group the order is the hash's.
	const searched = new Set((await loadFrames()).keys());
	const candidates = new Map<
		string,
		Array<{ gameId: string; color: "w" | "b"; player: string; h: number }>
	>();
	for await (const g of readJsonl<CorpusGame>(PATHS.corpus)) {
		const group = tcGroupOf(g.tc, g.control);
		if (group === "rapid:other") continue;
		for (const color of ["w", "b"] as const) {
			const side = g[color];
			if (side.kept === false) continue;
			// A side needs a few timed own moves to be worth replaying.
			if (g.plies.filter((p) => p.ply % 2 === (color === "w" ? 0 : 1)).length < 10) continue;
			const cell = `${group}|${wideBandOf(side.rating)}|${side.split}`;
			const list = candidates.get(cell) ?? [];
			list.push({ gameId: g.gameId, color, player: side.player, h: hash32(`${g.gameId}:${color}`) });
			candidates.set(cell, list);
		}
	}
	const sides: Selection["sides"] = [];
	for (const [cell, list] of candidates) {
		const [group, band] = cell.split("|") as [string, string];
		const high = (group === "bullet" || group === "blitz") && Number(band) >= 2200;
		const want = high ? perCellHigh : perCell;
		const perPlayerCount = new Map<string, number>();
		const rank = (c: { gameId: string; h: number }) => (searched.has(c.gameId) ? 0 : 1);
		let taken = 0;
		for (const c of list.sort((a, b) => rank(a) - rank(b) || a.h - b.h)) {
			if (taken >= want) break;
			const n = perPlayerCount.get(c.player) ?? 0;
			if (n >= perPlayer) continue;
			perPlayerCount.set(c.player, n + 1);
			sides.push({ gameId: c.gameId, color: c.color, split: cell.split("|")[2] ?? "", cell });
			taken++;
		}
	}
	const games = [...new Set(sides.map((s) => s.gameId))];
	await Bun.write(SELECT_PATH, `${JSON.stringify({ sides, games })}\n`);
	const byCell = new Map<string, number>();
	for (const s of sides) byCell.set(s.cell, (byCell.get(s.cell) ?? 0) + 1);
	console.log(`${sides.length} sides from ${games.length} games`);
	for (const [c, n] of [...byCell].sort()) console.log(`  ${c}: ${n}`);
}

if (import.meta.main) await main();
