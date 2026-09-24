/**
 * tools/calibration/crawl-chesscom/archive.ts — a chess.com monthly-archive game and the corpus
 * filter that accepts it (rated standard chess from the start position, both ratings, a live time
 * class, at least 20 clock comments).
 */

import { parseTimeControl, type StoredGame, type TimeClass } from "../common";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface ArchiveSide {
	username?: string;
	rating?: number;
	result?: string;
}

export interface ArchiveGame {
	url?: string;
	uuid?: string;
	pgn?: string;
	time_control?: string;
	time_class?: string;
	rules?: string;
	rated?: boolean;
	end_time?: number;
	initial_setup?: string;
	white?: ArchiveSide;
	black?: ArchiveSide;
}

export function isTimeClass(s: string | undefined): s is TimeClass {
	return s === "bullet" || s === "blitz" || s === "rapid";
}

/** Count of `[%clk` comments, which chess.com writes once per ply. */
function clockCount(pgn: string): number {
	let n = 0;
	let i = pgn.indexOf("[%clk");
	while (i !== -1) {
		n++;
		i = pgn.indexOf("[%clk", i + 5);
	}
	return n;
}

/** The corpus filter; returns the stored shape, or null when the game is out. */
export function acceptGame(g: ArchiveGame): StoredGame | null {
	if (g.rules !== "chess" || g.rated !== true || !isTimeClass(g.time_class)) return null;
	if (!g.uuid || !g.pgn || !g.time_control || !g.white || !g.black) return null;
	if (g.initial_setup && g.initial_setup !== START_FEN) return null;
	if (/\[SetUp "1"\]/.test(g.pgn) || /\[FEN "/.test(g.pgn)) return null;
	const w = g.white;
	const b = g.black;
	if (!w.username || !b.username || !(Number(w.rating) > 0) || !(Number(b.rating) > 0)) return null;
	if (!parseTimeControl(g.time_control)) return null;
	if (clockCount(g.pgn) < 20) return null;
	return {
		uuid: g.uuid,
		url: g.url ?? "",
		end_time: g.end_time ?? 0,
		time_control: g.time_control,
		time_class: g.time_class,
		white: { username: w.username, rating: Number(w.rating), result: w.result ?? "" },
		black: { username: b.username, rating: Number(b.rating), result: b.result ?? "" },
		pgn: g.pgn,
	};
}
