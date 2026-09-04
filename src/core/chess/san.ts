/**
 * UCI ⇄ SAN conversion and move application on chess.js (Task 5).
 * Every function returns `null`/`[]` rather than throwing on bad input.
 */

import type { PromoPiece, Square } from "@typedefs/game";
import type { Chess, Move } from "chess.js";
import { loadPosition } from "./fen";
import { isSquare } from "./squares";

/** Long algebraic move: `e2e4`, `e7e8q`. */
export type Uci = string;

export interface UciParts {
	from: Square;
	to: Square;
	promotion?: PromoPiece;
}

function isPromoPiece(c: string): c is PromoPiece {
	return c === "q" || c === "r" || c === "b" || c === "n";
}

export function parseUci(uci: Uci): UciParts | null {
	if (uci.length !== 4 && uci.length !== 5) return null;
	const from = uci.slice(0, 2);
	const to = uci.slice(2, 4);
	if (!isSquare(from) || !isSquare(to)) return null;
	if (uci.length === 4) return { from, to };
	const promo = uci.charAt(4);
	return isPromoPiece(promo) ? { from, to, promotion: promo } : null;
}

function moveToUci(m: Move): Uci {
	return `${m.from}${m.to}${m.promotion ?? ""}`;
}

/** Play `uci` on `chess` in place; `null` (position untouched) if illegal. */
export function playUci(chess: Chess, uci: Uci): Move | null {
	const parts = parseUci(uci);
	if (!parts) return null;
	try {
		return chess.move(
			parts.promotion === undefined
				? { from: parts.from, to: parts.to }
				: { from: parts.from, to: parts.to, promotion: parts.promotion }
		);
	} catch {
		return null;
	}
}

export function uciToSan(fen: string, uci: Uci): string | null {
	const chess = loadPosition(fen);
	if (!chess) return null;
	return playUci(chess, uci)?.san ?? null;
}

export function sanToUci(fen: string, san: string): Uci | null {
	const chess = loadPosition(fen);
	if (!chess) return null;
	try {
		return moveToUci(chess.move(san));
	} catch {
		return null;
	}
}

/** SAN for each move of `pv` up to (not including) the first illegal one. */
export function pvToSan(fen: string, pv: readonly Uci[]): string[] {
	const chess = loadPosition(fen);
	if (!chess) return [];
	const out: string[] = [];
	for (const uci of pv) {
		const m = playUci(chess, uci);
		if (!m) break;
		out.push(m.san);
	}
	return out;
}

/** FEN after playing every move of `moves`; `null` if any is illegal. */
export function applyMoves(fen: string, moves: readonly Uci[]): string | null {
	const chess = loadPosition(fen);
	if (!chess) return null;
	for (const uci of moves) if (!playUci(chess, uci)) return null;
	return chess.fen();
}

/** All legal moves in UCI form (`[]` on an invalid FEN). */
export function legalMoves(fen: string): Uci[] {
	const chess = loadPosition(fen);
	if (!chess) return [];
	return chess.moves({ verbose: true }).map(moveToUci);
}
