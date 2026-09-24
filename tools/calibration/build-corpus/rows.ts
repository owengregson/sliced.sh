/**
 * tools/calibration/build-corpus/rows.ts — one sampled (game, side) → its corpus rows: the own
 * moves from `MIN_PLY` with readable clocks, the player's fit/holdout split, and the optional
 * contiguous window of a side's rows.
 */

import { createHash } from "node:crypto";
import { parseTimeControl, type TimeClass } from "../common";
import { historyWindow, parsePgn, type ReplayedGame, replaySans } from "./pgn";

/** Own moves are skipped before this ply (half-moves played before the position). */
export const MIN_PLY = 16;

export type Split = "fit" | "holdout";

export interface CalibrationRow {
	id: string;
	gameId: string;
	ply: number;
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
	humanMove: string;
	clockMs: number;
	oppClockMs: number;
	baseMs: number;
	incrementMs: number;
	lastMove: string;
	prevOwnMove: string;
	thinkMs: number;
	tc: TimeClass;
	bucket: number;
	player: string;
	color: "w" | "b";
	split: Split;
	/** 1-based index of this move among the side's own moves (ply 16 by White is move 9). */
	moveNumberInGame: number;
}

/** The fit/holdout split, by player: first byte of sha1(`calib:${player}`) < 154 → fit (≈ 60 %). */
export function splitFor(player: string): Split {
	const first = createHash("sha1").update(`calib:${player.toLowerCase()}`).digest()[0] ?? 0;
	return first < 154 ? "fit" : "holdout";
}

export interface SampleContext {
	uuid: string;
	side: "w" | "b";
	tc: TimeClass;
	bucket: number;
	player: string;
	selfElo: number;
	oppoElo: number;
	timeControl: string;
}

/** All corpus rows for one sampled side of one game; empty when the PGN does not replay. */
export function rowsForSample(pgn: string, ctx: SampleContext): CalibrationRow[] {
	const tcParsed = parseTimeControl(ctx.timeControl);
	if (!tcParsed) return [];
	const baseMs = Math.round(tcParsed.baseS * 1000);
	const incrementMs = Math.round(tcParsed.incS * 1000);
	const parsed = parsePgn(pgn);
	let game: ReplayedGame;
	try {
		game = replaySans(parsed.sans);
	} catch {
		return [];
	}
	const clocks = parsed.clocksMs;
	const clockAfter = (ply: number): number | null => (ply < 0 ? baseMs : (clocks[ply] ?? null));
	const own = ctx.side === "w" ? 0 : 1;
	const split = splitFor(ctx.player);
	const rows: CalibrationRow[] = [];
	for (let ply = own; ply < game.ucis.length; ply += 2) {
		if (ply < MIN_PLY) continue;
		if ((game.legalCounts[ply] ?? 0) < 2) continue;
		const clockMs = clockAfter(ply - 2);
		const oppClockMs = clockAfter(ply - 1);
		const nowMs = clockAfter(ply);
		if (clockMs === null || oppClockMs === null || nowMs === null) continue;
		const fen = game.fens[ply] as string;
		rows.push({
			id: `${ctx.uuid}:${ply}`,
			gameId: ctx.uuid,
			ply,
			fen,
			historyFens: historyWindow(game.fens, ply),
			selfElo: ctx.selfElo,
			oppoElo: ctx.oppoElo,
			humanMove: game.ucis[ply] as string,
			clockMs,
			oppClockMs,
			baseMs,
			incrementMs,
			lastMove: game.ucis[ply - 1] as string,
			prevOwnMove: game.ucis[ply - 2] as string,
			thinkMs: clockMs - nowMs + incrementMs,
			tc: ctx.tc,
			bucket: ctx.bucket,
			player: ctx.player,
			color: ctx.side,
			split,
			moveNumberInGame: Math.floor(ply / 2) + 1,
		});
	}
	return rows;
}

/** A contiguous run of `n` rows starting at a position fixed by `key` (all rows when fewer). */
export function windowOf<T>(rows: readonly T[], n: number, key: string): T[] {
	if (rows.length <= n) return [...rows];
	const digest = createHash("sha1").update(`window:${key}`).digest();
	const start = digest.readUInt32BE(0) % (rows.length - n + 1);
	return rows.slice(start, start + n);
}
