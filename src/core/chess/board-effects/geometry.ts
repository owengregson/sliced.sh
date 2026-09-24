/** Board geometry for the effect rays: slider directions, lines between squares, castling rooks. */

import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import type { Square } from "@typedefs/game";

export const SLIDER_DIRECTIONS: Readonly<
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

/** The rook's two squares for a castle whose king landed on `kingTo`. */
export function castlingRook(
	kingTo: Square,
	kingside: boolean
): { from: Square; to: Square } | null {
	const rank = rankOf(kingTo);
	const from = squareOf(kingside ? 7 : 0, rank);
	const to = squareOf(kingside ? 5 : 3, rank);
	return from && to ? { from, to } : null;
}
