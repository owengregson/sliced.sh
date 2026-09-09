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
	/**
	 * The move carries an engine evaluation, so it belongs in the §13.6 quality pair. A premove
	 * (decided before the position existed) and a book move the engine's lines never ranked do
	 * not: scoring them as zero-loss non-top-1 moves would drag both numbers down.
	 */
	scored: boolean;
	/** The played move was the engine's first line (only read when `scored`). */
	top1: boolean;
	/** Centipawn loss of the played move (only read when `scored`). */
	cpLoss: number;
}

/**
 * Running per-move accumulator. `moves` counts every move played and is the divisor for
 * `avgThinkMs`; `scoredMoves` counts the evaluated ones and is the divisor for the §13.6 pair,
 * so a `SessionStats` read back from storage resumes exactly where it left off on both axes.
 */
export function foldMove(stats: SessionStats, move: MoveOutcome): SessionStats {
	const moves = stats.moves + 1;
	const next: SessionStats = {
		...stats,
		moves,
		avgThinkMs: ((stats.avgThinkMs ?? 0) * stats.moves + move.thinkMs) / moves,
	};
	if (!move.scored) return next;
	const scored = (stats.scoredMoves ?? 0) + 1;
	const mean = (previous: number | undefined, value: number): number =>
		((previous ?? 0) * (scored - 1) + value) / scored;
	next.scoredMoves = scored;
	next.top1Pct = mean(stats.top1Pct, move.top1 ? PERCENT : 0);
	next.acpl = mean(stats.acpl, Math.max(0, move.cpLoss));
	return next;
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
