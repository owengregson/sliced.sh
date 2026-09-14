/**
 * What a move *did* to the board (owner's brief, 2026-09-13) — the directional effect list the
 * overlay draws. Pure chess.js reading of the position before and after the move; no engine, no
 * settings, no I/O, so the whole thing is unit-testable in microseconds.
 *
 * Every effect is a ray from one square to another. The vocabulary, the caps and the drawing
 * numbers live in `@core/constants/board-effects` (C1); this module only decides which rays exist.
 *
 * The threat rule is `@core/chess/threat`'s `cheapThreats` widened the way the brief asks: an
 * attack on a non-pawn, non-king enemy piece that is **either** undefended **or** attacked by a
 * cheaper piece. `cheapThreats` answers the second half for every piece on the board at once;
 * here the question is narrower (what does *this* piece, on *this* square, now hit) and the
 * undefended half is added, so the two share the value table rather than the loop.
 */

import { loadPosition } from "@core/chess/fen";
import { PIECE_VALUES, type PieceType } from "@core/chess/material";
import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import { type BoardEffect, BOARD_EFFECT_LIMITS as L } from "@core/constants/board-effects";
import type { Color, Square } from "@typedefs/game";
import type { Chess, Move } from "chess.js";
import { playUci } from "./san";

/**
 * What the king is worth when comparing targets. `PIECE_VALUES.k` is 0 (it is a material table and
 * the king is never traded), but a pin *against* the king is the most valuable one there is, so
 * the comparisons below need a number that beats every other piece.
 */
export const KING_WORTH = 100;

const SLIDER_DIRECTIONS: Readonly<
	Record<"b" | "r" | "q", ReadonlyArray<readonly [number, number]>>
> = {
	b: [
		[1, 1],
		[1, -1],
		[-1, 1],
		[-1, -1],
	],
	r: [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	],
	q: [
		[1, 1],
		[1, -1],
		[-1, 1],
		[-1, -1],
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	],
};

function worth(type: PieceType): number {
	return type === "k" ? KING_WORTH : PIECE_VALUES[type];
}

function other(color: Color): Color {
	return color === "w" ? "b" : "w";
}

/**
 * Squares strictly between `a` and `b` along a rank, file or diagonal; `[]` when the two are not
 * aligned (or are the same square).
 */
export function squaresBetween(a: Square, b: Square): Square[] {
	const df = fileOf(b) - fileOf(a);
	const dr = rankOf(b) - rankOf(a);
	if (df === 0 && dr === 0) return [];
	if (df !== 0 && dr !== 0 && Math.abs(df) !== Math.abs(dr)) return [];
	const stepF = Math.sign(df);
	const stepR = Math.sign(dr);
	const out: Square[] = [];
	let file = fileOf(a) + stepF;
	let rank = rankOf(a) + stepR;
	while (file !== fileOf(b) || rank !== rankOf(b)) {
		const sq = squareOf(file, rank);
		if (!sq) return [];
		out.push(sq);
		file += stepF;
		rank += stepR;
	}
	return out;
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

function kingSquareOf(chess: Chess, color: Color): Square | null {
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

/** The rook's two squares for a castle whose king landed on `kingTo`. */
function castlingRook(kingTo: Square, kingside: boolean): { from: Square; to: Square } | null {
	const rank = rankOf(kingTo);
	const from = squareOf(kingside ? 7 : 0, rank);
	const to = squareOf(kingside ? 5 : 3, rank);
	return from && to ? { from, to } : null;
}

/** Pin and skewer chains the slider now standing on `at` creates; each chain is two rays. */
function restraintChains(chess: Chess, at: Square, attacker: Color): BoardEffect[] {
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
function discoveries(chess: Chess, move: Move, attacker: Color): BoardEffect[] {
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

export interface BoardEffectsInput {
	/** Position before the move. */
	fen: string;
	/** The move that was played, in UCI (`e2e4`, `e7e8q`). */
	uci: string;
}

/**
 * The effects `uci` produced in `fen`, in drawing order: what physically happened first (capture,
 * en passant, castle, promotion), then the check, then the new threats, then what the move
 * uncovered or restrained. `[]` for an invalid position or an illegal move.
 *
 * Same-kind effects are emitted consecutively on purpose: the overlay staggers a run of them
 * (`BOARD_EFFECT_STYLES[kind].delayMs`), which is what turns two or more threat rays into a fan.
 */
export function boardEffectsFor(input: BoardEffectsInput): BoardEffect[] {
	const chess = loadPosition(input.fen);
	if (!chess) return [];
	const move = playUci(chess, input.uci);
	if (!move) return [];
	const mover = move.color as Color;
	const them = other(mover);
	const before: BoardEffect[] = [];
	const after: BoardEffect[] = [];

	if (move.captured !== undefined) before.push({ kind: "capture", from: move.from, to: move.to });
	if (move.flags.includes("e")) {
		const taken = squareOf(fileOf(move.to), rankOf(move.from));
		if (taken) before.push({ kind: "passant", from: move.to, to: taken });
	}
	const kingside = move.flags.includes("k");
	if (kingside || move.flags.includes("q")) {
		before.push({ kind: "castle", from: move.from, to: move.to });
		const rook = castlingRook(move.to, kingside);
		if (rook) before.push({ kind: "castle", from: rook.from, to: rook.to });
	}
	if (move.promotion !== undefined) before.push({ kind: "promotion", from: move.to, to: move.to });

	// The check, and who is actually giving it: a checker that is not the piece that moved is a
	// discovered check, which the brief wants drawn from the uncovering piece rather than the mover.
	let directCheck = false;
	const king = chess.inCheck() ? kingSquareOf(chess, them) : null;
	if (king) {
		for (const checker of chess.attackers(king, mover)) {
			if (checker === move.to) {
				directCheck = true;
				before.push({ kind: "check", from: move.to, to: king });
			} else before.push({ kind: "discovery", from: checker, to: king });
		}
	}

	const targets = winnableTargets(chess, move.to, mover).slice(0, L.maxThreats);
	// Two or more things hit at once from one square is a fork — the check counts as a prong.
	const fork = targets.length + (directCheck ? 1 : 0) >= 2 && targets.length >= 1;
	for (const target of targets)
		after.push({ kind: fork ? "fork" : "threat", from: move.to, to: target });
	after.push(...discoveries(chess, move, mover));
	after.push(...restraintChains(chess, move.to, mover));

	// One ray per pair of squares. A bishop that pins a knight both *threatens* it and *restrains*
	// it, and drawing the same line twice reads as one thicker line rather than as two ideas; the
	// earlier effect wins, which is the more specific one in emission order.
	const seen = new Set<string>();
	const unique: BoardEffect[] = [];
	for (const effect of [...before, ...after]) {
		const pair = `${effect.from}${effect.to}`;
		if (seen.has(pair)) continue;
		seen.add(pair);
		unique.push(effect);
	}
	return unique.slice(0, L.maxEffects);
}
