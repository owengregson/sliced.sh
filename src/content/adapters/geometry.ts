/**
 * Square ⇄ viewport geometry (Appendix C §1.9). chess.com's board element is
 * exactly the 8×8 playing area, so `rect.width / 8` is the square size;
 * `flipped` means black is at the bottom (`.flipped` / `getOptions().flipped`).
 */

import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import type { Square } from "@typedefs/game";
import type { Point, Rect } from "./adapter";

interface RectLike {
	left?: number;
	top?: number;
	x?: number;
	y?: number;
	width: number;
	height: number;
}

function origin(rect: RectLike): { left: number; top: number } {
	return { left: rect.left ?? rect.x ?? 0, top: rect.top ?? rect.y ?? 0 };
}

/** Column/row (0 = left/top of the screen) of a square in the given orientation. */
function screenCell(sq: Square, flipped: boolean): { col: number; row: number } {
	const f = fileOf(sq);
	const r = rankOf(sq);
	return flipped ? { col: 7 - f, row: r } : { col: f, row: 7 - r };
}

export function squareToPoint(sq: Square, rect: RectLike, flipped: boolean): Point {
	const { left, top } = origin(rect);
	const s = rect.width / 8;
	const { col, row } = screenCell(sq, flipped);
	return { x: left + col * s + s / 2, y: top + row * s + s / 2 };
}

/** Inverse of `squareToPoint`; `null` outside the board. Mirrors chessground `getKeyAtDomPos`. */
export function pointToSquare(p: Point, rect: RectLike, flipped: boolean): Square | null {
	const { left, top } = origin(rect);
	if (!(rect.width > 0) || !(rect.height > 0)) return null;
	const col = Math.floor((8 * (p.x - left)) / rect.width);
	const row = Math.floor((8 * (p.y - top)) / rect.height);
	if (col < 0 || col > 7 || row < 0 || row > 7) return null;
	const file = flipped ? 7 - col : col;
	const rank = flipped ? row : 7 - row;
	return squareOf(file, rank);
}

export function squareRect(sq: Square, rect: RectLike, flipped: boolean): Rect {
	const { left, top } = origin(rect);
	const s = rect.width / 8;
	const { col, row } = screenCell(sq, flipped);
	const x = left + col * s;
	const y = top + row * s;
	return { x, y, width: s, height: s, left: x, top: y, right: x + s, bottom: y + s };
}
