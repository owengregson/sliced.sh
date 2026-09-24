/**
 * tools/timing-calibration/sim/premove-facts.ts — the engine-dependent half of the premove arm,
 * computed once per row: what the shipped `premoveCandidate` returns over the cached frames when
 * every random draw passes. The replay draws the random gates per chain.
 */

import { classifyMove } from "@core/chess/move-classify";
import { legalMoves } from "@core/chess/san";
import { PREMOVE } from "@core/constants";
import { createRng, type Rng } from "@core/rng";
import { isQueueableCandidate, premoveCandidate, replyProbability } from "@core/strength/premove";
import { plausibleScore, predictionLines } from "@core/strength/premove/prediction";
import type { EvalLine } from "@typedefs/engine";
import type { CorpusGame, TimingRow } from "../common";
import { type CompactLine, toEvalLines } from "../frames";

/** The engine-dependent half of the arm for a row: what `premoveCandidate` returns if every draw passes. */
export interface PremoveFacts {
	reply: string;
	premove: string;
	reason: string;
	queueable: boolean;
	safeTrade: boolean;
	/** The candidate was the primary prediction (ordinary premoves need that). */
	primary: boolean;
}

const ALWAYS: Rng = (() => {
	const r = createRng("always");
	return { ...r, chance: () => true, next: () => 0 };
})();

export function compact(lines: CompactLine[] | undefined, depth: number): EvalLine[] {
	return lines ? toEvalLines(lines, depth) : [];
}

/**
 * `premoveCandidate` over cached frames with every draw passing (piP 1). `relaxed` is the
 * calibrated gate (`tradeReplyMinProb` for captures). Only the played reply's position has a
 * frame, so a reply the prediction ranks before it that could itself arm (it passes its own gate)
 * is assumed to take the arm, which is pessimistic for the played one.
 */
export async function premoveFacts(
	game: CorpusGame,
	frames: CompactLine[][],
	depth: number,
	row: TimingRow,
	relaxed: boolean
): Promise<PremoveFacts | null> {
	const t = row.ply;
	if (t < 2) return null;
	const oppLines = compact(frames[t - 1], depth);
	const actual = game.ucis[t - 1] as string;
	const afterMove = game.fens[t - 1] as string;
	const gateOf = (reply: string): number =>
		relaxed && classifyMove(afterMove, reply)?.isCapture === true
			? PREMOVE.tradeReplyMinProb
			: PREMOVE.replyMinProb;
	if (replyProbability(actual, oppLines) < gateOf(actual)) return null;
	const legal = legalMoves(afterMove);
	const ranked = predictionLines(oppLines, legal);
	const best = ranked[0];
	for (const line of ranked) {
		const reply = line.pvUci[0];
		if (!reply || reply === actual) break;
		if (best && plausibleScore(line, best) && replyProbability(reply, ranked) >= gateOf(reply))
			return null;
	}
	const ownLines = compact(frames[t], depth);
	const fenBefore = game.fens[t - 2] as string;
	const move = game.ucis[t - 2] as string;
	const oppPly = game.plies.find((p) => p.ply === t - 1);
	const candidate = await premoveCandidate(
		{
			fen: fenBefore,
			move,
			historyAfterMove: { fen: game.fens[0] as string, moves: game.ucis.slice(0, t - 1) },
			targetElo: row.rating,
			timeControl: { baseMs: row.baseMs, incMs: row.incMs },
			ownClockMs: row.clockMs,
			opponentClockMs: oppPly ? oppPly.clockMs : row.oppClockMs,
			ponder: oppLines[0]?.pvUci[0],
			rng: ALWAYS,
			piP: 1,
			...(relaxed ? { propensity: { tradeReplyMinProb: PREMOVE.tradeReplyMinProb } } : {}),
		},
		{
			analyseAfter: async (_fen, moves) =>
				moves.length === 1 ? oppLines : moves[1] === actual ? ownLines : [],
		}
	);
	if (!candidate || candidate.reply !== actual) return null;
	const queueable = isQueueableCandidate(afterMove, candidate);
	return {
		reply: candidate.reply,
		premove: candidate.premove,
		reason: candidate.reason,
		queueable,
		safeTrade: candidate.reason === "recapture" && queueable,
		primary: oppLines[0]?.pvUci[0] === candidate.reply,
	};
}
