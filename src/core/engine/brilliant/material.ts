/**
 * Material accounting: what a move wins by itself, the bounded legal exchange on its square, and
 * the plain material balance the illusion tests compare.
 */

import { loadPosition } from "@core/chess/fen";
import { PIECE_VALUES } from "@core/chess/material";
import { BRILLIANT } from "@core/constants/review";
import type { Chess, Move } from "chess.js";
import type { BrilliantTuning } from "./types";

/** The shared node count one material search spends against `BRILLIANT.maxExchangeNodes`. */
export type SearchBudget = { nodes: number };

export function uciOf(move: Move): string {
	return move.from + move.to + (move.promotion ?? "");
}

/**
 * Material a move wins by itself: the captured piece and a promotion's upgrade. `pawnsOf` prices
 * that side's pawns at nothing — the piece-only exchange of `BRILLIANT.pawnLossNotSacrifice`.
 */
export function gain(move: Move, pawnsOf?: "w" | "b"): number {
	const free = move.captured === "p" && pawnsOf !== undefined && move.color !== pawnsOf;
	return (
		(move.captured && !free ? PIECE_VALUES[move.captured] : 0) +
		(move.promotion ? PIECE_VALUES[move.promotion] - PIECE_VALUES.p : 0)
	);
}

/**
 * What `move`'s side nets from the legal captures on `move.to` that follow, either side free to
 * stop exchanging. `null` when the bounded search gives up.
 */
export function exchangeGain(
	board: Chess,
	move: Move,
	tuning: BrilliantTuning,
	budget: SearchBudget,
	plies = 0,
	pawnsOf?: "w" | "b"
): number | null {
	if (++budget.nodes > tuning.maxExchangeNodes || plies >= tuning.maxExchangePlies) return null;
	board.move(move);
	try {
		const legal = board.moves({ verbose: true });
		// A forced recapture cannot be replaced by the usual SEE stand-pat value of zero.
		const canStop =
			legal.length === 0 || legal.some((reply) => !reply.captured || reply.to !== move.to);
		let replyGain = canStop ? 0 : Number.NEGATIVE_INFINITY;
		for (const reply of legal) {
			if (!reply.captured || reply.to !== move.to) continue;
			const value = exchangeGain(board, reply, tuning, budget, plies + 1, pawnsOf);
			if (value === null) return null;
			replyGain = Math.max(replyGain, value);
		}
		return gain(move, pawnsOf) - replyGain;
	} finally {
		board.undo();
	}
}

/**
 * The static exchange of `uci` itself: the material the move nets on its destination square once
 * the legal captures there are played out. `null` for an illegal move or an exhausted search.
 */
export function staticExchange(
	fen: string,
	uci: string,
	tuning: BrilliantTuning = BRILLIANT
): number | null {
	const board = loadPosition(fen);
	const move = board?.moves({ verbose: true }).find((m) => uciOf(m) === uci);
	if (!board || !move) return null;
	return exchangeGain(board, move, tuning, { nodes: 0 });
}

/** The mover's material minus the opponent's, in pawn units (kings excluded). */
export function balance(board: Chess, color: "w" | "b"): number {
	let total = 0;
	for (const row of board.board())
		for (const piece of row)
			if (piece && piece.type !== "k")
				total += (piece.color === color ? 1 : -1) * PIECE_VALUES[piece.type];
	return total;
}
