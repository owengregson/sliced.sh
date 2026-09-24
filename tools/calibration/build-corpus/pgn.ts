/**
 * tools/calibration/build-corpus/pgn.ts — chess.com PGN as the corpus reads it: headers, SAN moves
 * and the per-ply `[%clk]` clocks, the SAN replay into FENs / UCI / legal-move counts, and the Maia
 * history window before a ply.
 */

import { Chess } from "chess.js";
import { MAIA_INPUT } from "../../../src/core/constants/maia";

/** `"0:02:59.9"` / `"2:59"` / `"59.3"` → milliseconds, or null when unreadable. */
export function parseClockMs(text: string): number | null {
	const parts = text.trim().split(":");
	if (parts.length === 0 || parts.length > 3) return null;
	let seconds = 0;
	for (const p of parts) {
		if (!/^\d+(?:\.\d+)?$/.test(p)) return null;
		seconds = seconds * 60 + Number(p);
	}
	return Math.round(seconds * 1000);
}

/** A chess.js move → UCI, promotion as a lowercase suffix. */
export function toUci(move: { from: string; to: string; promotion?: string | undefined }): string {
	return `${move.from}${move.to}${move.promotion ? move.promotion.toLowerCase() : ""}`;
}

export interface ParsedPgn {
	headers: Record<string, string>;
	/** SAN per ply. */
	sans: string[];
	/** Clock after each ply (ms), null where the ply carried no `[%clk]`. */
	clocksMs: Array<number | null>;
}

/** Headers, SAN moves and per-ply clocks. Variations `( … )` and NAGs are skipped. */
export function parsePgn(pgn: string): ParsedPgn {
	const headers: Record<string, string> = {};
	const lines = pgn.replace(/\r\n?/g, "\n").split("\n");
	let i = 0;
	for (; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (line === "") {
			if (Object.keys(headers).length > 0) break;
			continue;
		}
		const m = /^\[(\w+)\s+"(.*)"\]$/.exec(line);
		if (!m) break;
		headers[m[1] as string] = (m[2] as string).replace(/\\"/g, '"');
	}
	const movetext = lines.slice(i).join(" ");
	const sans: string[] = [];
	const clocksMs: Array<number | null> = [];
	const token =
		/\{([^}]*)\}|\(|\)|;[^\n]*|\$\d+|(\d+)\.(?:\.\.)?|(1-0|0-1|1\/2-1\/2|\*)|([^\s{}()]+)/g;
	let depth = 0;
	for (let m = token.exec(movetext); m !== null; m = token.exec(movetext)) {
		const whole = m[0];
		if (whole === "(") {
			depth++;
			continue;
		}
		if (whole === ")") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (depth > 0) continue;
		if (m[1] !== undefined) {
			const clk = /\[%clk\s+([\d:.]+)\]/.exec(m[1]);
			if (clk?.[1] && clocksMs.length > 0 && clocksMs[clocksMs.length - 1] === null) {
				clocksMs[clocksMs.length - 1] = parseClockMs(clk[1]);
			}
			continue;
		}
		if (m[2] !== undefined || m[3] !== undefined || whole.startsWith(";") || whole.startsWith("$"))
			continue;
		if (m[4] !== undefined) {
			const san = m[4].replace(/[!?]+$/, "");
			if (san === "") continue;
			sans.push(san);
			clocksMs.push(null);
		}
	}
	return { headers, sans, clocksMs };
}

export interface ReplayedGame {
	/** FEN before each ply, plus the final position (length = plies + 1). */
	fens: string[];
	/** UCI per ply. */
	ucis: string[];
	/** Legal move count before each ply. */
	legalCounts: number[];
}

/** Replay SAN moves from the start position; throws on an illegal move. */
export function replaySans(sans: readonly string[]): ReplayedGame {
	const board = new Chess();
	const fens = [board.fen()];
	const ucis: string[] = [];
	const legalCounts: number[] = [];
	for (const san of sans) {
		legalCounts.push(board.moves().length);
		const move = board.move(san);
		ucis.push(toUci(move));
		fens.push(board.fen());
	}
	return { fens, ucis, legalCounts };
}

/** The last ≤ `MAIA_INPUT.history` positions oldest → newest ending with the position before `ply`. */
export function historyWindow(fens: readonly string[], ply: number): string[] {
	return fens.slice(Math.max(0, ply + 1 - MAIA_INPUT.history), ply + 1);
}
