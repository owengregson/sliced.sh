/**
 * tools/lib/pgn/thinks.ts — per-move think times from an export's clock readings:
 * `think = clk_prev − clk_now + inc`, with `clk_prev` = the base clock for a side's first move.
 */

import type { ParsedGame } from "./export";

/** One think, already attributed to a side. */
export interface Think {
	/** Our move number for this side (1-based). */
	moveNo: number;
	/** Seconds spent. */
	thinkS: number;
	/** Seconds on this player's own clock before the move. */
	clockBeforeS: number;
	/** Seconds on this player's own clock after the move. */
	clockAfterS: number;
	/** `clockBeforeS / base` — what that player had on their own clock *before* the move. */
	fraction: number;
}

/**
 * The thinks of one side of one game. `side` is 0 for White, 1 for Black; `clk_prev` starts at the
 * base clock and every later move reads that side's own previous `[%clk]`.
 */
export function thinksOf(game: ParsedGame, side: 0 | 1, baseSec: number, incSec: number): Think[] {
	const out: Think[] = [];
	let previous = baseSec;
	let moveNo = 0;
	for (let ply = side; ply < game.clocksAfterPly.length; ply += 2) {
		const now = game.clocksAfterPly[ply];
		if (now === undefined || !Number.isFinite(now)) break;
		moveNo += 1;
		const thinkS = previous - now + incSec;
		// A negative think means added time (`moretime`) or a clock oddity — drop the row, but keep
		// the clock reading so the rest of the game stays attributed correctly.
		if (thinkS >= 0)
			out.push({
				moveNo,
				thinkS: Number(thinkS.toFixed(3)),
				clockBeforeS: previous,
				clockAfterS: now,
				fraction: previous / baseSec,
			});
		previous = now;
	}
	return out;
}
