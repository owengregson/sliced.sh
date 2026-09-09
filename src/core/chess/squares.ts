/**
 * Square arithmetic (Task 5). Files and ranks are 0-based indices
 * (`a1` → file 0, rank 0; `h8` → file 7, rank 7).
 */

import type { Square } from "@typedefs/game";

const FILES = "abcdefgh";
const RANKS = "12345678";

export function isSquare(s: string): s is Square {
	return s.length === 2 && FILES.includes(s.charAt(0)) && RANKS.includes(s.charAt(1));
}

/** 0-based file index (`a` → 0 … `h` → 7). */
export function fileOf(sq: Square): number {
	return FILES.indexOf(sq.charAt(0));
}

/** 0-based rank index (`1` → 0 … `8` → 7). */
export function rankOf(sq: Square): number {
	return RANKS.indexOf(sq.charAt(1));
}

/** Inverse of `fileOf`/`rankOf`; `null` when either index is off the board. */
export function squareOf(file: number, rank: number): Square | null {
	if (!Number.isInteger(file) || !Number.isInteger(rank)) return null;
	const f = FILES.charAt(file);
	const r = RANKS.charAt(rank);
	if (f === "" || r === "") return null;
	const sq = `${f}${r}`;
	return isSquare(sq) ? sq : null;
}

/** Every square, `a1` … `h8` (file-major). */
export const ALL_SQUARES: readonly Square[] = (() => {
	const out: Square[] = [];
	for (let file = 0; file < FILES.length; file += 1)
		for (let rank = 0; rank < RANKS.length; rank += 1) {
			const sq = squareOf(file, rank);
			if (sq) out.push(sq);
		}
	return out;
})();

export interface SquareDistance {
	/** King-move distance: max(|Δfile|, |Δrank|). */
	chebyshev: number;
	/** Straight-line distance in square units. */
	euclidean: number;
}

export function distance(a: Square, b: Square): SquareDistance {
	const df = Math.abs(fileOf(a) - fileOf(b));
	const dr = Math.abs(rankOf(a) - rankOf(b));
	return { chebyshev: Math.max(df, dr), euclidean: Math.sqrt(df * df + dr * dr) };
}
