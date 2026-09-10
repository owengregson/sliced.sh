/**
 * DOM → piece placement and the hybrid FEN strategy (Appendix C §1.2, §3).
 * `placementFromDom` returns `null` while the board is unstable (duplicate
 * square, animation, too few pieces) so callers retry on the next mutation.
 */

import { loadPosition } from "@core/chess/fen";
import { fileOf, rankOf } from "@core/chess/squares";
import { CHESS_START_FEN } from "@core/constants/chess";
import type { Color, Square } from "@typedefs/game";
import { SELECTORS } from "./selectors";

type Grid = Array<Array<string | null>>;

function emptyGrid(): Grid {
	return Array.from({ length: 8 }, () => Array<string | null>(8).fill(null));
}

/** `grid[0]` is rank 8, `grid[7]` rank 1; columns are files a..h. */
export function gridToPlacement(grid: Grid): string {
	return grid
		.map((row) => {
			let out = "";
			let empty = 0;
			for (const c of row) {
				if (c) {
					if (empty) {
						out += empty;
						empty = 0;
					}
					out += c;
				} else empty++;
			}
			return empty ? out + empty : out;
		})
		.join("/");
}

/** Inverse of `gridToPlacement`; `null` on malformed input. */
export function placementToGrid(placement: string): Grid | null {
	const rows = placement.split("/");
	if (rows.length !== 8) return null;
	const grid = emptyGrid();
	for (let r = 0; r < 8; r++) {
		const row = rows[r] ?? "";
		let file = 0;
		for (const ch of row) {
			if (/[1-8]/.test(ch)) file += Number(ch);
			else if (/[prnbqkPRNBQK]/.test(ch)) {
				if (file > 7) return null;
				const line = grid[r];
				if (line) line[file] = ch;
				file++;
			} else return null;
		}
		if (file !== 8) return null;
	}
	return grid;
}

/** Piece letter (`P`, `n`, …) on `sq`, or `null`. */
export function pieceAt(placement: string, sq: Square): string | null {
	const grid = placementToGrid(placement);
	return grid?.[7 - rankOf(sq)]?.[fileOf(sq)] ?? null;
}

/** chess.com: `.piece` elements with `[wb][prnbqk]` + `square-XY` classes in any order. */
export function placementFromDom(board: Element): string | null {
	const grid = emptyGrid();
	let count = 0;
	for (const el of board.querySelectorAll(SELECTORS.piece)) {
		const cls = el.getAttribute("class") ?? "";
		const p = SELECTORS.pieceCodeRe.exec(cls);
		const s = SELECTORS.squareRe.exec(cls);
		if (!p || !s) continue;
		const file = Number(s[1]) - 1;
		const rank = Number(s[2]) - 1;
		const code = p[2] ?? "";
		const ch = p[1] === "w" ? code.toUpperCase() : code;
		const row = grid[7 - rank];
		if (!row) continue;
		if (row[file]) return null; // duplicate square ⇒ mid-animation / pool; retry
		row[file] = ch;
		count++;
	}
	return count < 2 ? null : gridToPlacement(grid);
}

/** Placement field of a FEN. */
export function placementOf(fen: string): string {
	return fen.split(" ")[0] ?? "";
}

export interface Replay {
	fen: string;
	lastMove: { from: Square; to: Square; san: string } | null;
}

/** Replay SAN through chess.js; `null` if any move is illegal or the start FEN invalid. */
export function replayMoves(
	sans: readonly string[],
	startFen: string = CHESS_START_FEN
): Replay | null {
	const chess = loadPosition(startFen);
	if (!chess) return null;
	let lastMove: Replay["lastMove"] = null;
	for (const san of sans) {
		try {
			const m = chess.move(san, { strict: false });
			lastMove = { from: m.from, to: m.to, san: m.san };
		} catch {
			return null;
		}
	}
	return { fen: chess.fen(), lastMove };
}

export function replayFen(
	sans: readonly string[],
	startFen: string = CHESS_START_FEN
): string | null {
	return replayMoves(sans, startFen)?.fen ?? null;
}

export interface ApproximateOptions {
	fullmove?: number;
	lastMove?: { from: Square; to: Square };
}

/**
 * Full FEN from a DOM placement when replay is unavailable or disagrees
 * (Appendix C §3.3): castling rights from king/rook home squares, ep from a
 * pawn double-step, halfmove 0.
 */
export function approximateFen(
	placement: string,
	turn: Color,
	opts: ApproximateOptions = {}
): string {
	const at = (sq: Square): string | null => pieceAt(placement, sq);
	let castling = "";
	if (at("e1") === "K") {
		if (at("h1") === "R") castling += "K";
		if (at("a1") === "R") castling += "Q";
	}
	if (at("e8") === "k") {
		if (at("h8") === "r") castling += "k";
		if (at("a8") === "r") castling += "q";
	}
	let ep = "-";
	const lm = opts.lastMove;
	if (lm) {
		const piece = at(lm.to);
		const df = fileOf(lm.from) - fileOf(lm.to);
		const dr = rankOf(lm.to) - rankOf(lm.from);
		if (piece === "P" && df === 0 && dr === 2) ep = `${lm.from.charAt(0)}3`;
		if (piece === "p" && df === 0 && dr === -2) ep = `${lm.from.charAt(0)}6`;
	}
	const fullmove = opts.fullmove ?? 1;
	return `${placement} ${turn} ${castling || "-"} ${ep} 0 ${fullmove}`;
}
