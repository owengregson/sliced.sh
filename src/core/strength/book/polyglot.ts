/**
 * Polyglot opening-book reader (Task 15, Appendix E §2.2). A `.bin` book is a
 * key-sorted array of 16-byte big-endian entries `{ key: u64, move: u16,
 * weight: u16, learn: u32 }`; `polyglotKey` is the Zobrist hash the format
 * defines over `RANDOM64`. Pure: no I/O, no randomness.
 */

import { loadPosition, parseFen } from "@core/chess/fen";
import { parseUci } from "@core/chess/san";
import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import type { Square } from "@typedefs/game";
import {
	RANDOM64,
	RANDOM64_CASTLE_OFFSET,
	RANDOM64_EN_PASSANT_OFFSET,
	RANDOM64_PIECE_OFFSET,
	RANDOM64_TURN_OFFSET,
} from "./random64";

export interface BookMove {
	uci: string;
	/** Relative frequency/priority (u16). */
	weight: number;
	/** Learning field (u32); unused by the policy but surfaced for completeness. */
	learn: number;
}

export interface PolyglotBook {
	/** Number of 16-byte entries. */
	size: number;
	lookup(fen: string): BookMove[];
}

const ENTRY_BYTES = 16;
/** Piece "kind" per the spec: bp, wp, bn, wn, bb, wb, br, wr, bq, wq, bk, wk. */
const PIECE_KIND: Readonly<Record<string, number>> = {
	p: 0,
	P: 1,
	n: 2,
	N: 3,
	b: 4,
	B: 5,
	r: 6,
	R: 7,
	q: 8,
	Q: 9,
	k: 10,
	K: 11,
};
const CASTLE_INDEX: Readonly<Record<string, number>> = { K: 0, Q: 1, k: 2, q: 3 };
const PROMO_PIECES = ["", "n", "b", "r", "q"] as const;

function random(index: number): bigint {
	const value = RANDOM64[index];
	if (value === undefined) throw new RangeError(`Random64 index ${index} out of range`);
	return value;
}

interface Board {
	/** `pieces[rank][file]` FEN piece letter or "" (rank 0 = rank 1). */
	at(file: number, rank: number): string;
}

function boardOf(placement: string): Board {
	const rows = placement.split("/");
	if (rows.length !== 8) throw new RangeError("polyglotKey: malformed placement");
	const grid: string[][] = [];
	for (let r = 7; r >= 0; r--) {
		const row = rows[7 - r] ?? "";
		const cells: string[] = [];
		for (const ch of row) {
			const n = Number(ch);
			if (Number.isInteger(n) && n > 0) for (let i = 0; i < n; i++) cells.push("");
			else cells.push(ch);
		}
		if (cells.length !== 8) throw new RangeError("polyglotKey: malformed rank");
		grid[r] = cells;
	}
	return { at: (file, rank) => grid[rank]?.[file] ?? "" };
}

/**
 * The position's Polyglot key: pieces ⊕ castling ⊕ en-passant (only when a
 * pawn of the side to move can actually capture) ⊕ white-to-move.
 */
export function polyglotKey(fen: string): bigint {
	const parts = parseFen(fen);
	if (!parts) throw new RangeError("polyglotKey: invalid FEN");
	const board = boardOf(parts.placement);
	let key = 0n;
	for (let rank = 0; rank < 8; rank++) {
		for (let file = 0; file < 8; file++) {
			const piece = board.at(file, rank);
			if (piece === "") continue;
			const kind = PIECE_KIND[piece];
			if (kind === undefined) throw new RangeError(`polyglotKey: unknown piece ${piece}`);
			key ^= random(RANDOM64_PIECE_OFFSET + 64 * kind + 8 * rank + file);
		}
	}
	if (parts.castling !== "-") {
		for (const flag of parts.castling) {
			const index = CASTLE_INDEX[flag];
			if (index !== undefined) key ^= random(RANDOM64_CASTLE_OFFSET + index);
		}
	}
	if (parts.enPassant !== null) {
		const file = fileOf(parts.enPassant);
		// The capturing pawn stands beside the double-pushed pawn: rank 5 for white, rank 4 for black.
		const pawnRank = parts.turn === "w" ? 4 : 3;
		const pawn = parts.turn === "w" ? "P" : "p";
		const canCapture =
			(file > 0 && board.at(file - 1, pawnRank) === pawn) ||
			(file < 7 && board.at(file + 1, pawnRank) === pawn);
		if (canCapture) key ^= random(RANDOM64_EN_PASSANT_OFFSET + file);
	}
	if (parts.turn === "w") key ^= random(RANDOM64_TURN_OFFSET);
	return key;
}

/** Encode a UCI move in the book's 16-bit layout (castling given as the king move or as king-takes-rook). */
export function encodePolyglotMove(uci: string): number {
	const parts = parseUci(uci);
	if (!parts) throw new RangeError(`encodePolyglotMove: invalid uci ${uci}`);
	const promo = parts.promotion === undefined ? 0 : PROMO_PIECES.indexOf(parts.promotion);
	return (
		fileOf(parts.to) |
		(rankOf(parts.to) << 3) |
		(fileOf(parts.from) << 6) |
		(rankOf(parts.from) << 9) |
		(promo << 12)
	);
}

/** Castling is stored as king-takes-rook; the remap applies only when a king is on the from-square. */
const CASTLE_REMAP: Readonly<Record<string, string>> = {
	e1h1: "e1g1",
	e1a1: "e1c1",
	e8h8: "e8g8",
	e8a8: "e8c8",
};

function kingOn(fen: string, square: Square): boolean {
	const chess = loadPosition(fen);
	if (!chess) return false;
	return chess.get(square)?.type === "k";
}

/** Decode a 16-bit book move for the position `fen` into UCI. */
export function decodePolyglotMove(encoded: number, fen: string): string {
	const from = squareOf((encoded >> 6) & 7, (encoded >> 9) & 7);
	const to = squareOf(encoded & 7, (encoded >> 3) & 7);
	if (from === null || to === null) throw new RangeError("decodePolyglotMove: bad square");
	let uci = `${from}${to}`;
	const remapped = CASTLE_REMAP[uci];
	if (remapped !== undefined && kingOn(fen, from)) uci = remapped;
	const promo = PROMO_PIECES[(encoded >> 12) & 7];
	if (promo === undefined) throw new RangeError("decodePolyglotMove: bad promotion");
	return uci + promo;
}

function viewOf(book: Uint8Array): DataView {
	if (book.byteLength % ENTRY_BYTES !== 0)
		throw new RangeError("polyglot: book size is not a multiple of 16 bytes");
	return new DataView(book.buffer, book.byteOffset, book.byteLength);
}

function lookupIn(view: DataView, fen: string): BookMove[] {
	const key = polyglotKey(fen);
	const n = view.byteLength / ENTRY_BYTES;
	let lo = 0;
	let hi = n;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (view.getBigUint64(mid * ENTRY_BYTES, false) < key) lo = mid + 1;
		else hi = mid;
	}
	const out: BookMove[] = [];
	for (let i = lo; i < n && view.getBigUint64(i * ENTRY_BYTES, false) === key; i++) {
		const off = i * ENTRY_BYTES;
		out.push({
			uci: decodePolyglotMove(view.getUint16(off + 8, false), fen),
			weight: view.getUint16(off + 10, false),
			learn: view.getUint32(off + 12, false),
		});
	}
	return out;
}

/** Every book entry for `fen` (binary search on the sorted keys). */
export function lookup(book: Uint8Array, fen: string): BookMove[] {
	return lookupIn(viewOf(book), fen);
}

/** Validate the bytes once and bind `lookup` to them. */
export function loadBook(bytes: Uint8Array): PolyglotBook {
	const view = viewOf(bytes);
	return { size: view.byteLength / ENTRY_BYTES, lookup: (fen) => lookupIn(view, fen) };
}
