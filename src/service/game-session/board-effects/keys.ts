/** What "the same position" and "the same move" mean to the reporter, and landed-ply recovery. */

import { positionKey } from "@core/chess/history";
import { applyMoves, legalMoves } from "@core/chess/san";
import type { Square } from "@typedefs/game";

import type { ClassifiedMove } from "./types";

/** Placement, side to move and castling/ep rights — what "the same position" means here. */
function boardKey(fen: string): string {
	return positionKey(fen);
}

/** Halfmove count separates repetitions and positions approaching the fifty-move draw. */
export function reviewKey(fen: string): string {
	return fen.trim().split(/\s+/).slice(0, 5).join(" ");
}

/** One verdict per (ply, position, move): a plan and the move that lands share it. */
export function moveKey(move: ClassifiedMove): string {
	return `${move.ply}|${reviewKey(move.beforeFen)}|${move.uci}`;
}

function uciOf(fen: string, from: Square, to: Square): string | null {
	const base = `${from}${to}`;
	const legal = legalMoves(fen);
	if (legal.includes(base)) return base;
	return legal.find((m) => m.startsWith(base)) ?? null;
}

/**
 * The plies that took the board from `beforeFen` to `afterFen`, given the site's last-move
 * marking. Usually one. Two when a queued premove fired the instant the opponent moved (Fix F):
 * the marking is *our* move, played from a position this session never saw, so the opponent's
 * reply is recovered by trying every legal one. `null` when neither reading holds.
 */
export function landedPlies(
	beforeFen: string,
	last: { from: Square; to: Square },
	afterFen: string
): string[] | null {
	const direct = uciOf(beforeFen, last.from, last.to);
	if (direct !== null) return [direct];
	const want = boardKey(afterFen);
	for (const reply of legalMoves(beforeFen)) {
		const middle = applyMoves(beforeFen, [reply]);
		if (middle === null) continue;
		const ours = uciOf(middle, last.from, last.to);
		if (ours === null) continue;
		const both = applyMoves(middle, [ours]);
		if (both !== null && boardKey(both) === want) return [reply, ours];
	}
	return null;
}
