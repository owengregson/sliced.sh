/**
 * Material counting straight from the FEN placement field (Task 5).
 * Standard 1/3/3/5/9 scale; kings are worth 0.
 */

import { parseFen } from "./fen";

export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

export const PIECE_VALUES: Readonly<Record<PieceType, number>> = {
	p: 1,
	n: 3,
	b: 3,
	r: 5,
	q: 9,
	k: 0,
};

export interface Material {
	w: number;
	b: number;
	/** `w - b`. */
	diff: number;
}

function isPieceType(c: string): c is PieceType {
	return c === "p" || c === "n" || c === "b" || c === "r" || c === "q" || c === "k";
}

function count(placement: string, includePawns: boolean): Material {
	let w = 0;
	let b = 0;
	for (const ch of placement) {
		const lower = ch.toLowerCase();
		if (!isPieceType(lower) || (!includePawns && lower === "p")) continue;
		const v = PIECE_VALUES[lower];
		if (ch === lower) b += v;
		else w += v;
	}
	return { w, b, diff: w - b };
}

/** Total material per side (pawns included); `null` on an invalid FEN. */
export function material(fen: string): Material | null {
	const parts = parseFen(fen);
	return parts ? count(parts.placement, true) : null;
}

/** Non-pawn material summed over both sides (62 at the start); `null` on an invalid FEN. */
export function nonPawnMaterial(fen: string): number | null {
	const parts = parseFen(fen);
	if (!parts) return null;
	const m = count(parts.placement, false);
	return m.w + m.b;
}
