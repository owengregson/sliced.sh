/**
 * What a move *did* to the board (owner's brief, 2026-09-13) — the directional effect list the
 * overlay draws. Pure chess.js reading of the position before and after the move; no engine, no
 * settings, no I/O, so the whole thing is unit-testable in microseconds.
 *
 * Every effect is a ray from one square to another. The vocabulary, the caps and the drawing
 * numbers live in `@core/constants/board-effects` (C1); this module only decides which rays exist.
 *
 * The geometry lives in `./board-effects/geometry`, the tactical readings (threats, pins,
 * discoveries) in `./board-effects/tactics`; this module orders them into the drawing list.
 */

import { loadPosition } from "@core/chess/fen";
import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import { type BoardEffect, BOARD_EFFECT_LIMITS as L } from "@core/constants/board-effects";
import type { Color } from "@typedefs/game";
import { castlingRook } from "./board-effects/geometry";
import {
	discoveries,
	kingSquareOf,
	other,
	restraintChains,
	winnableTargets,
} from "./board-effects/tactics";
import { playUci } from "./san";

export { squaresBetween } from "./board-effects/geometry";
export { KING_WORTH, winnableTargets } from "./board-effects/tactics";

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
