// test/core/motor/fixtures.ts — shared board geometry and path helpers for the motor tests.
import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import type { PathPoint, Pt, Rect } from "@core/motor/types";
import type { Square } from "@typedefs/game";

export const BOARD: Rect = { left: 100, top: 60, width: 640, height: 640 };
export const SQ = BOARD.width / 8;

export function squareRect(sq: Square, flipped = false, board: Rect = BOARD): Rect {
	const size = board.width / 8;
	const f = flipped ? 7 - fileOf(sq) : fileOf(sq);
	const r = flipped ? rankOf(sq) : 7 - rankOf(sq);
	return { left: board.left + f * size, top: board.top + r * size, width: size, height: size };
}

export function geometry(flipped = false, board: Rect = BOARD) {
	return { boardRect: board, squareRect: (sq: Square) => squareRect(sq, flipped, board) };
}

export function centre(r: Rect): Pt {
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function inside(p: Pt, r: Rect, pad = 0): boolean {
	return (
		p.x >= r.left + pad &&
		p.x <= r.left + r.width - pad &&
		p.y >= r.top + pad &&
		p.y <= r.top + r.height - pad
	);
}

export function totalMs(path: readonly PathPoint[]): number {
	let t = 0;
	for (const p of path) t += p.dtMs;
	return t;
}

export function dist(a: Pt, b: Pt): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export const ALL_SQUARES: Square[] = [];
for (let r = 0; r < 8; r++)
	for (let f = 0; f < 8; f++) {
		const sq = squareOf(f, r);
		if (sq) ALL_SQUARES.push(sq);
	}

/** Speeds in px/ms between consecutive points (index 0 is from `start`). */
export function speeds(start: Pt, path: readonly PathPoint[]): number[] {
	const out: number[] = [];
	let prev = start;
	for (const p of path) {
		out.push(dist(prev, p) / Math.max(1, p.dtMs));
		prev = p;
	}
	return out;
}

export function smooth(values: readonly number[], window = 5): number[] {
	const half = Math.floor(window / 2);
	return values.map((_, i) => {
		let s = 0;
		let n = 0;
		for (let j = i - half; j <= i + half; j++) {
			const v = values[j];
			if (v !== undefined) {
				s += v;
				n++;
			}
		}
		return s / Math.max(1, n);
	});
}
