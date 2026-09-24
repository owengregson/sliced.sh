/**
 * The tactical readings behind the effect rays: what a piece now hits and can win, the pins and
 * skewers a slider creates, and the attacks a move uncovers.
 *
 * The threat rule is `@core/chess/threat`'s `cheapThreats` widened the way the brief asks: an
 * attack on a non-pawn, non-king enemy piece that is **either** undefended **or** attacked by a
 * cheaper piece. `cheapThreats` answers the second half for every piece on the board at once;
 * here the question is narrower (what does *this* piece, on *this* square, now hit) and the
 * undefended half is added, so the two share the value table rather than the loop.
 */

import { PIECE_VALUES, type PieceType } from "@core/chess/material";
import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import { type BoardEffect, BOARD_EFFECT_LIMITS as L } from "@core/constants/board-effects";
import type { Color, Square } from "@typedefs/game";
import type { Chess, Move } from "chess.js";
import { SLIDER_DIRECTIONS, squaresBetween } from "./geometry";

/**
 * What the king is worth when comparing targets. `PIECE_VALUES.k` is 0 (it is a material table and
 * the king is never traded), but a pin *against* the king is the most valuable one there is, so
 * the comparisons below need a number that beats every other piece.
 */
export const KING_WORTH = 100;

function worth(type: PieceType): number {
	return type === "k" ? KING_WORTH : PIECE_VALUES[type];
}

export function other(color: Color): Color {
	return color === "w" ? "b" : "w";
}

/** Every square holding a piece of `color`. */
function piecesOf(chess: Chess, color: Color): Array<{ square: Square; type: PieceType }> {
	const out: Array<{ square: Square; type: PieceType }> = [];
	for (const row of chess.board())
		for (const cell of row)
			if (cell && cell.color === color)
				out.push({ square: cell.square, type: cell.type as PieceType });
	return out;
}

export function kingSquareOf(chess: Chess, color: Color): Square | null {
	return piecesOf(chess, color).find((p) => p.type === "k")?.square ?? null;
}

/**
 * The enemy pieces `from` attacks and can win: non-pawn, non-king, and either undefended or
 * attacked by something cheaper than they are. `chess` is the position *after* the move, and
 * `attacker` is the side that played it (which is not the side to move).
 */
export function winnableTargets(chess: Chess, from: Square, attacker: Color): Square[] {
	const piece = chess.get(from);
	if (!piece || piece.color !== attacker) return [];
	const attackerValue = worth(piece.type as PieceType);
	const defender = other(attacker);
	const out: Square[] = [];
	for (const target of piecesOf(chess, defender)) {
		if (target.type === "p" || target.type === "k") continue;
		if (!chess.attackers(target.square, attacker).includes(from)) continue;
		const undefended = chess.attackers(target.square, defender).length === 0;
		if (undefended || attackerValue < worth(target.type)) out.push(target.square);
	}
	return out;
}

/** Pin and skewer chains the slider now standing on `at` creates; each chain is two rays. */
export function restraintChains(chess: Chess, at: Square, attacker: Color): BoardEffect[] {
	const piece = chess.get(at);
	if (!piece || piece.color !== attacker) return [];
	const directions = SLIDER_DIRECTIONS[piece.type as "b" | "r" | "q"] as
		| ReadonlyArray<readonly [number, number]>
		| undefined;
	if (!directions) return [];
	const attackerValue = worth(piece.type as PieceType);
	const defender = other(attacker);
	const out: BoardEffect[] = [];
	for (const [df, dr] of directions) {
		let front: { square: Square; type: PieceType } | null = null;
		let file = fileOf(at) + df;
		let rank = rankOf(at) + dr;
		while (true) {
			const sq = squareOf(file, rank);
			if (!sq) break;
			const cell = chess.get(sq);
			file += df;
			rank += dr;
			if (!cell) continue;
			if (cell.color !== defender) break; // one of ours blocks the line
			const type = cell.type as PieceType;
			if (front === null) {
				front = { square: sq, type };
				continue;
			}
			// A pawn behind is not a restraint worth drawing, and neither is a line that wins
			// nothing: the piece at the back has to be worth more than the piece doing the pinning.
			if (type !== "p" && worth(type) > attackerValue) {
				out.push({ kind: "pin", from: at, to: front.square });
				out.push({ kind: "pin", from: front.square, to: sq });
			}
			break;
		}
		if (out.length >= L.maxPins * 2) break;
	}
	return out.slice(0, L.maxPins * 2);
}

/**
 * Attacks a *different* piece of ours gained because the move vacated its square — a discovered
 * attack, the non-check half (a discovered check is reported as `discovery` onto the king by
 * `boardEffectsFor` itself).
 */
export function discoveries(chess: Chess, move: Move, attacker: Color): BoardEffect[] {
	const out: BoardEffect[] = [];
	for (const target of piecesOf(chess, other(attacker))) {
		if (target.type === "p" || target.type === "k") continue;
		for (const from of chess.attackers(target.square, attacker)) {
			if (from === move.to) continue;
			const piece = chess.get(from);
			if (!piece || !(piece.type === "b" || piece.type === "r" || piece.type === "q")) continue;
			if (!squaresBetween(from, target.square).includes(move.from)) continue;
			if (!winnableTargets(chess, from, attacker).includes(target.square)) continue;
			out.push({ kind: "discovery", from, to: target.square });
			if (out.length >= L.maxDiscoveries) return out;
		}
	}
	return out;
}
