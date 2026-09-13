/**
 * Maia-3 input encoding and move vocabulary — written from the paper's description (Monroe et
 * al., ICLR 2026 §3) and the fixture, **not** transcribed from `maia3/dataset.py` (AGPL; see
 * `docs/research/maia3-feasibility-2026-09-11.md` §2.3).
 *
 * Contract (bit-exact against `test/fixtures/maia3/positions.json`):
 * - 64 square tokens in a1…h8 order (file fastest: a1, b1, …, h1, a2, …), each with
 *   `MAIA_INPUT.tokenDim` = 8 positions × 12 planes; the 8 positions are the last 8 of the game
 *   oldest → newest (columns `0–11` the oldest, `84–95` the current); fewer positions are padded
 *   by repeating the **earliest** one at the front.
 * - Every position is mirrored **on its own** side to move: when black is to move in that
 *   position, ranks are flipped (a1 ↔ a8) and colours swapped, so "own" pieces are always white
 *   and always move up the board. The 12 planes are pawn, knight, bishop, rook, queen, king for
 *   the side to move, then the same six for the opponent (one-hot, 1.0).
 * - Move vocabulary of 4352: index `fromSq · 64 + toSq` for the 4096 from→to pairs (square index
 *   `file + 8 · rank`, a1 = 0), then promotions ordered by from-file, to-file and piece
 *   `q, r, b, n` (`4096 + (fromFile · 8 + toFile) · 4 + piece`), always rank 7 → 8 in the mirrored
 *   frame. A black move is mirrored (ranks flipped) before indexing and mirrored back after.
 *   Castling is the king's from→to, en passant the pawn's; a promotion uses only its promotion
 *   index, never the from→to one.
 *
 * `encodeMaiaInputs` allocates one `Float32Array(64 · 96)` and one `Int32Array` per call; the
 * placement is read straight off the FEN's first field once chess.js has accepted the position.
 */

import { loadPosition } from "@core/chess/fen";
import { parseUci } from "@core/chess/san";
import { MAIA_INPUT, type MaiaSize } from "@core/constants/maia";

export interface MaiaEncoded {
	/** `Float32Array(64 · 96)`, square-major (`square · 96 + feature`). */
	tokens: Float32Array;
	/** `MAIA_INPUT.moveVocab` indices of the legal moves in the mirrored frame, ascending. */
	legal: Int32Array;
	/** Black to move in `fen` — the frame is mirrored. */
	mirrored: boolean;
}

const HISTORY = MAIA_INPUT.history;
const PLANES = MAIA_INPUT.planes;
const TOKEN_DIM = MAIA_INPUT.tokenDim;
const SQUARES = MAIA_INPUT.squares;
const FROM_TO = MAIA_INPUT.fromTo;
const MOVE_VOCAB = MAIA_INPUT.moveVocab;
const PROMOTION_PIECES: readonly string[] = MAIA_INPUT.promotionPieces;

/** Piece letter (lower case) → plane within the six of one colour. */
const PIECE_PLANE: Readonly<Record<string, number>> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };

const FILE_A = "a".charCodeAt(0);
const RANK_1 = "1".charCodeAt(0);
const RANK_7 = 6;
const RANK_8 = 7;

/** `file + 8 · rank` for a two-character square, ranks flipped when `mirrored`. */
function squareIndex(square: string, mirrored: boolean): number {
	const file = square.charCodeAt(0) - FILE_A;
	const rank = square.charCodeAt(1) - RANK_1;
	return file + 8 * (mirrored ? 7 - rank : rank);
}

/** Inverse of `squareIndex`. */
function squareName(index: number, mirrored: boolean): string {
	const file = index & 7;
	const rank = index >> 3;
	return String.fromCharCode(FILE_A + file, RANK_1 + (mirrored ? 7 - rank : rank));
}

/**
 * Paint one position's 12 planes into `frame` of `tokens`. `placement` is the FEN's first field
 * (ranks 8 → 1, files a → h); `mirrored` flips the ranks and swaps the colours.
 */
function paintFrame(
	tokens: Float32Array,
	placement: string,
	mirrored: boolean,
	frame: number
): void {
	const base = frame * PLANES;
	let rank = 7;
	let file = 0;
	for (let i = 0; i < placement.length; i++) {
		const ch = placement.charAt(i);
		if (ch === "/") {
			rank--;
			file = 0;
			continue;
		}
		const code = ch.charCodeAt(0);
		if (code >= RANK_1 && code < RANK_1 + 8) {
			file += code - RANK_1 + 1;
			continue;
		}
		const lower = ch.toLowerCase();
		const plane = PIECE_PLANE[lower];
		if (plane === undefined) throw new Error(`maia-encoder: unreadable placement "${placement}"`);
		const white = ch !== lower;
		const own = white !== mirrored;
		const square = file + 8 * (mirrored ? 7 - rank : rank);
		tokens[square * TOKEN_DIM + base + plane + (own ? 0 : 6)] = 1;
		file++;
	}
}

/** Encode `historyFens` (oldest → newest, last = the position to move in). Throws on an unreadable FEN. */
export function encodeMaiaInputs(historyFens: readonly string[]): MaiaEncoded {
	const fens = historyFens.length > HISTORY ? historyFens.slice(-HISTORY) : historyFens;
	if (fens.length === 0) throw new Error("maia-encoder: no position to encode");
	const frames: Array<{ placement: string; mirrored: boolean }> = [];
	let current: ReturnType<typeof loadPosition> = null;
	for (const fen of fens) {
		const chess = loadPosition(fen);
		if (!chess) throw new Error(`maia-encoder: unreadable FEN "${fen}"`);
		const placement = fen.trim().split(/\s+/)[0] ?? "";
		frames.push({ placement, mirrored: chess.turn() === "b" });
		current = chess;
	}
	if (!current) throw new Error("maia-encoder: no position to encode");
	const tokens = new Float32Array(SQUARES * TOKEN_DIM);
	const pad = HISTORY - frames.length;
	for (let frame = 0; frame < HISTORY; frame++) {
		const source = frames[Math.max(0, frame - pad)];
		if (source) paintFrame(tokens, source.placement, source.mirrored, frame);
	}
	const mirrored = current.turn() === "b";
	const moves = current.moves({ verbose: true });
	const legal = new Int32Array(moves.length);
	let n = 0;
	for (const move of moves) {
		const index = maiaMoveIndex(`${move.from}${move.to}${move.promotion ?? ""}`, mirrored);
		if (index >= 0) legal[n++] = index;
	}
	return { tokens, legal: legal.subarray(0, n).sort(), mirrored };
}

/** Vocabulary index of a UCI move in the given frame (`mirrored` flips ranks first); `-1` if unrepresentable. */
export function maiaMoveIndex(uci: string, mirrored: boolean): number {
	const parts = parseUci(uci);
	if (!parts) return -1;
	const from = squareIndex(parts.from, mirrored);
	const to = squareIndex(parts.to, mirrored);
	if (parts.promotion === undefined) return from * 64 + to;
	if (from >> 3 !== RANK_7 || to >> 3 !== RANK_8) return -1;
	const piece = PROMOTION_PIECES.indexOf(parts.promotion);
	if (piece < 0) return -1;
	return FROM_TO + ((from & 7) * 8 + (to & 7)) * 4 + piece;
}

/** Inverse of `maiaMoveIndex`: the board-frame UCI for a vocabulary index. */
export function maiaIndexToUci(index: number, mirrored: boolean): string {
	if (!Number.isInteger(index) || index < 0 || index >= MOVE_VOCAB)
		throw new RangeError(`maia-encoder: move index ${index} outside the vocabulary`);
	if (index < FROM_TO) return squareName(index >> 6, mirrored) + squareName(index & 63, mirrored);
	const promotion = index - FROM_TO;
	const piece = PROMOTION_PIECES[promotion & 3] ?? "q";
	const files = promotion >> 2;
	const from = (files >> 3) + 8 * RANK_7;
	const to = (files & 7) + 8 * RANK_8;
	return squareName(from, mirrored) + squareName(to, mirrored) + piece;
}

/** Which size a `MaiaEncoded` query should be answered with is the caller's business; re-exported for symmetry. */
export type { MaiaSize };
