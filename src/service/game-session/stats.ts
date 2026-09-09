/**
 * Session statistics (`LOCAL_KEYS.sessionStats`, §13.6 session strip). The
 * `GameSession` folds every played move into the running totals and every
 * finished game into `games` / `outOfBandStreak`; the panel broadcaster reads
 * the key back (a storage write pushes a snapshot on its own).
 *
 * `top1Pct` and `acpl` are the Appendix E §1.6 agreement pair for the derived
 * target: the share of played moves that were the engine's first line, and the
 * mean centipawn loss of the chosen moves. `outOfBandStreak` counts consecutive
 * *finished games* whose end-of-game pair sat outside the band
 * (`checkBand`), and the Live view warns after three.
 */

import { checkBand } from "@core/strength/bands";
import type { SessionStats } from "@typedefs/game";

const PERCENT = 100;

export const EMPTY_STATS: Readonly<SessionStats> = Object.freeze({
	games: 0,
	moves: 0,
	avgThinkMs: 0,
});

export interface MoveOutcome {
	/** Realised think time of the move (ms). */
	thinkMs: number;
	/** The played move was the engine's first line. */
	top1: boolean;
	/** Centipawn loss of the played move. */
	cpLoss: number;
}

/**
 * Running per-move accumulator. `moves` is the divisor for all three means, so
 * a `SessionStats` read back from storage resumes exactly where it left off.
 */
export function foldMove(stats: SessionStats, move: MoveOutcome): SessionStats {
	const n = stats.moves + 1;
	const mean = (previous: number | undefined, value: number): number =>
		((previous ?? 0) * stats.moves + value) / n;
	return {
		...stats,
		moves: n,
		avgThinkMs: mean(stats.avgThinkMs, move.thinkMs),
		top1Pct: mean(stats.top1Pct, move.top1 ? PERCENT : 0),
		acpl: mean(stats.acpl, Math.max(0, move.cpLoss)),
	};
}

/**
 * Fold a finished game: `games` goes up and `outOfBandStreak` either grows or
 * resets, judged on the session's running pair against `targetElo`'s band. A
 * session with no moves yet counts as in band (`checkBand`'s rule).
 */
export function foldGame(stats: SessionStats, targetElo: number): SessionStats {
	const verdict = checkBand(targetElo, stats);
	return {
		...stats,
		games: stats.games + 1,
		outOfBandStreak: verdict.inBand ? 0 : (stats.outOfBandStreak ?? 0) + 1,
	};
}
