/**
 * The move-quality verdict behind the board-effect chip (owner's brief, 2026-09-13). Pure: it is
 * handed full-strength MultiPV lines for the position *before* a move and (when the lines do not
 * already score it) the score of the move that was actually played, and it answers one of the ten
 * `MOVE_QUALITY_ORDER` categories.
 *
 * The bands, the overrides and the reasoning behind every number live in
 * `@core/constants/move-quality`; this file is the ladder, nothing else.
 *
 * Deliberately *not* `@core/strength/quality`'s `moveQuality`: that one answers "may this move be
 * counted in the session's accuracy statistics", which refuses mates, forced positions and
 * mismatched depths on purpose. A chip has to have an opinion about exactly those.
 */

import { loadPosition } from "@core/chess/fen";
import { PIECE_VALUES, type PieceType } from "@core/chess/material";
import { hangsOutright } from "@core/chess/safety";
import { parseUci } from "@core/chess/san";
import { type MoveQuality, MOVE_QUALITY as Q } from "@core/constants/move-quality";
import { cpEffective, winProb } from "@core/strength/elo-map";
import { rankedLines } from "@core/strength/quality";
import type { Eval, EvalLine } from "@typedefs/engine";

export interface MoveQualityInput {
	/** Position before the move. */
	fen: string;
	/** The move that was played, in UCI. */
	uci: string;
	/** Ply index of `fen` (0 = the start position), for the opening-book approximation. */
	ply: number;
	/** Full-strength MultiPV lines at `fen`, from the mover's point of view. */
	lines: readonly EvalLine[];
	/**
	 * The played move's score from the mover's point of view, for the common case where it is not
	 * one of the MultiPV lines. The caller gets it by negating the best score of the position
	 * after the move.
	 */
	playedScore?: Eval;
	/** The caller knows the move came out of the opening book (`RecommendationOutcome.fromBook`). */
	inBook?: boolean;
}

export interface MoveQualityVerdict {
	quality: MoveQuality;
	/** Win-probability loss against the best move, in [0, 1]. */
	lossWp: number;
	/** Centipawn loss on the `cpEffective` scale (a mate is ±(1000 + 100 − |N|)). */
	cpLoss: number;
	/** The move was the engine's first choice (or within `bestTieCp` of it). */
	top: boolean;
	/** Deepest complete depth the verdict rests on. */
	depth: number;
}

/** A sacrifice worth calling brilliant: a real piece left to be taken, not a pawn gambit. */
function isSacrifice(fen: string, uci: string): boolean {
	const parts = parseUci(uci);
	if (!parts) return false;
	const piece = loadPosition(fen)?.get(parts.from);
	if (!piece) return false;
	const given = parts.promotion ?? (piece.type as PieceType);
	if (PIECE_VALUES[given] < Q.brilliantMinPieceValue) return false;
	return hangsOutright(fen, uci);
}

/**
 * The verdict for `uci` played in `fen`, or `null` when there is not enough to say: no usable
 * line, a frame shallower than `MOVE_QUALITY.minDepth`, or a played move nothing scored.
 */
export function classifyMoveQuality(input: MoveQualityInput): MoveQualityVerdict | null {
	const ranked = rankedLines(input.lines);
	const best = ranked[0];
	if (!best || best.depth < Q.minDepth) return null;
	const played = ranked.find((line) => line.pvUci[0] === input.uci);
	const playedEval = played?.score ?? input.playedScore;
	if (!playedEval) return null;
	const bestCp = cpEffective(best.score);
	const playedCp = cpEffective(playedEval);
	const cpLoss = Math.max(0, bestCp - playedCp);
	const wpBest = winProb(bestCp);
	const wpPlayed = winProb(playedCp);
	const lossWp = Math.max(0, wpBest - wpPlayed);
	const top = best.pvUci[0] === input.uci || cpLoss <= Q.bestTieCp;
	const settle = (quality: MoveQuality): MoveQualityVerdict => ({
		quality,
		lossWp,
		cpLoss,
		top,
		depth: best.depth,
	});

	// Losing bands first, worst down. `miss` sits between blunder and mistake: failing to finish a
	// won game is worse than an ordinary mistake, and never worse than throwing it away.
	if (lossWp >= Q.blunderLoss) return settle("blunder");
	if (wpBest >= Q.missWinBefore && wpPlayed < Q.missKeptAfter && lossWp >= Q.missMinLoss)
		return settle("miss");
	if (lossWp >= Q.mistakeLoss) return settle("mistake");
	if (lossWp >= Q.inaccuracyLoss) return settle("inaccuracy");

	// A fine move, upgraded along the ladder. Each test can only move it up.
	let quality: MoveQuality = "good";
	if (lossWp < Q.excellentMaxLoss) quality = "excellent";
	if (top) quality = "best";
	const inBook = input.inBook ?? (input.ply < Q.bookMaxPly && lossWp <= Q.bookMaxLoss);
	if (inBook) quality = "book";
	const runnerUp = ranked[1];
	const onlyMove =
		top && runnerUp !== undefined && wpBest - winProb(cpEffective(runnerUp.score)) >= Q.greatGapWp;
	if (onlyMove) quality = "great";
	if ((onlyMove || top) && wpPlayed >= Q.brilliantMinWinAfter && isSacrifice(input.fen, input.uci))
		quality = "brilliant";
	return settle(quality);
}
