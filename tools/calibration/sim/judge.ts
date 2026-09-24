/**
 * tools/calibration/sim/judge.ts — a move against the referee's best line of the same frame
 * (expected-points loss, centipawn loss, top-1), and the position's difficulty (`PositionShape`)
 * the rating model reads. The bot and the human are judged by one `Judge` per position.
 */

import "../../lib/defines";
import { material } from "@core/chess/material";
import { legalMoves } from "@core/chess/san";
import { cpEffective, winProb } from "@core/strength/elo-map";
import { rankedLines } from "@core/strength/quality";
import type { FrameCacheRecord } from "../frames/schema";

/** How much a move gave away against the referee's best, and whether it was the best. */
export interface MoveOutcome {
	/** Win-probability loss (`winProb` on `cpEffective`), ≥ 0 — chess.com's expected-points loss. */
	winLoss: number;
	/** Centipawn loss on `cpEffective`, ≥ 0, capped at `CP_LOSS_CAP`. */
	cpLoss: number;
	/** 1 when the move is the referee's best line. */
	top1: number;
}

export const CP_LOSS_CAP = 1000;

/**
 * How hard the position is, from the referee frame alone (the same for every mover): the rating
 * model's covariates.
 */
export interface PositionShape {
	/** Scored moves within `NEAR_BEST_LOSS` of the best (the best included). */
	nearBest: number;
	/** The smallest loss among the other scored moves (how "only" the best move is), capped at 0.5. */
	secondLoss: number;
	/** `|2·winProb(best) − 1|`: 0 in a balanced position, → 1 in a decided one. */
	decided: number;
	/** Material on the board (both sides, pawn units) over the starting 78 — the game phase. */
	material?: number;
	/** Legal moves in the position (how much choice the mover has). */
	legal?: number;
}

/** The position's own facts for `PositionShape` (from the FEN; the frame supplies the rest). */
export function positionFacts(fen: string): { material: number; legal: number } {
	const m = material(fen);
	return { material: m ? (m.w + m.b) / 78 : 1, legal: legalMoves(fen).length };
}

export const NEAR_BEST_LOSS = 0.02;

export interface Judge {
	bestUci: string;
	shape: PositionShape;
	topCp: number;
	/** The referee's `cpEffective` score of `uci`, when scored. */
	cpOf(uci: string): number | undefined;
	/** The outcome of `uci`, or null when the frame never scored it. */
	outcome(uci: string): MoveOutcome | null;
}

export function judgeFor(frame: FrameCacheRecord): Judge {
	const ranked = rankedLines(frame.lines);
	const top = ranked[0];
	if (!top) throw new Error(`${frame.id}: the frame has no scored line`);
	const topCp = cpEffective(top.score);
	const winTop = winProb(topCp);
	const cpOf = new Map<string, number>();
	for (const line of frame.lines) {
		const uci = line.pvUci[0];
		if (uci !== undefined && !cpOf.has(uci)) cpOf.set(uci, cpEffective(line.score));
	}
	const humanUci = frame.humanLine?.pvUci[0];
	if (frame.humanLine && humanUci !== undefined && !cpOf.has(humanUci))
		cpOf.set(humanUci, cpEffective(frame.humanLine.score));
	const bestUci = top.pvUci[0] ?? "";
	let nearBest = 0;
	let secondLoss = 0.5;
	for (const line of frame.lines) {
		const uci = line.pvUci[0];
		if (uci === undefined) continue;
		const loss = Math.max(0, winTop - winProb(cpEffective(line.score)));
		if (loss <= NEAR_BEST_LOSS) nearBest++;
		if (uci !== bestUci) secondLoss = Math.min(secondLoss, loss);
	}
	return {
		bestUci,
		shape: { nearBest: Math.max(1, nearBest), secondLoss, decided: Math.abs(2 * winTop - 1) },
		topCp,
		cpOf: (uci) => cpOf.get(uci),
		outcome(uci) {
			const cp = cpOf.get(uci);
			if (cp === undefined) return null;
			return {
				winLoss: Math.max(0, winTop - winProb(cp)),
				cpLoss: Math.min(CP_LOSS_CAP, Math.max(0, topCp - cp)),
				top1: uci === bestUci ? 1 : 0,
			};
		},
	};
}
