/**
 * FEN parsing/formatting on top of chess.js (Task 5). Every entry point that
 * loads a position goes through `loadPosition`, which wraps `new Chess(fen)`
 * in a `try` and returns `null` on invalid input — no move generation here.
 */

import type { Color, Square } from "@typedefs/game";
import { Chess, validateFen } from "chess.js";
import { isSquare } from "./squares";

export interface FenParts {
	/** Piece placement field, ranks 8 → 1 separated by `/`. */
	placement: string;
	turn: Color;
	/** Castling availability as written (`KQkq`, a subset, or `-`). */
	castling: string;
	enPassant: Square | null;
	halfmove: number;
	fullmove: number;
}

/** chess.js position for `fen`, or `null` if chess.js rejects it. */
export function loadPosition(fen: string): Chess | null {
	try {
		return new Chess(fen);
	} catch {
		return null;
	}
}

export function isValidFen(fen: string): boolean {
	return validateFen(fen).ok;
}

/** Split a FEN into its six fields; `null` unless chess.js accepts it. */
export function parseFen(fen: string): FenParts | null {
	if (!isValidFen(fen)) return null;
	const fields = fen.trim().split(/\s+/);
	const [placement, turn, castling, ep, half, full] = fields;
	if (
		fields.length !== 6 ||
		placement === undefined ||
		castling === undefined ||
		ep === undefined ||
		(turn !== "w" && turn !== "b")
	)
		return null;
	const enPassant = ep === "-" ? null : isSquare(ep) ? ep : null;
	if (ep !== "-" && enPassant === null) return null;
	const halfmove = Number(half);
	const fullmove = Number(full);
	if (!Number.isInteger(halfmove) || !Number.isInteger(fullmove)) return null;
	return { placement, turn, castling, enPassant, halfmove, fullmove };
}

/** Inverse of `parseFen`. */
export function formatFen(parts: FenParts): string {
	const ep = parts.enPassant ?? "-";
	return `${parts.placement} ${parts.turn} ${parts.castling} ${ep} ${parts.halfmove} ${parts.fullmove}`;
}

export function sideToMove(fen: string): Color | null {
	return parseFen(fen)?.turn ?? null;
}

/** Ply index (0 at the start position) implied by the FEN's move counters. */
export function plyOf(parts: Pick<FenParts, "turn" | "fullmove">): number {
	return (parts.fullmove - 1) * 2 + (parts.turn === "b" ? 1 : 0);
}
