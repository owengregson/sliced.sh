/**
 * ChessMimic input tokeniser (Task 34; Appendix J §B item 2). Reproduces, bit for bit, what the
 * upstream model saw in training (`test/fixtures/chessmimic-reference.json` is generated from
 * the upstream `Training/tokenizer.py`):
 *
 *   - the google-deepmind/searchless_chess FEN tokeniser — 31 characters, side + 64 squares +
 *     castling (4) + en passant (2) + halfmove (3) + fullmove (3) = 77 tokens — plus ChessMimic's
 *     class token appended (78); `INPUT_VOCAB_SIZE` 33 = 31 characters + class (31) + pad (32);
 *   - the 1 968-entry UCI move vocabulary in `_compute_all_possible_actions` order: for every
 *     square a1…h8 the queen's attack squares on an empty board (ascending), then the knight's;
 *     then the promotions (ranks 2→1 and 7→8, files a…h, straight / left / right, q r b n);
 *   - the recent-move window (`chessmimic_core.prepare_recent_moves_tokens`): the last 12 moves,
 *     left-padded with the shared `PAD_TOKEN` (32). Upstream throws on a move outside the
 *     vocabulary (e.g. a Chess960 castling encoding); here such a move pads instead.
 */

import { TIMING_CONSTANTS } from "./constants";

const CM = TIMING_CONSTANTS.chessmimic;

export const FEN_CHARACTERS = [
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"a",
	"b",
	"c",
	"d",
	"e",
	"f",
	"g",
	"h",
	"p",
	"n",
	"r",
	"k",
	"q",
	"P",
	"B",
	"N",
	"R",
	"Q",
	"K",
	"w",
	".",
] as const;

const CHAR_INDEX = new Map<string, number>(FEN_CHARACTERS.map((c, i) => [c, i]));
const DOT = CHAR_INDEX.get(".") ?? 30;

/** 31 characters + class + pad. */
export const INPUT_VOCAB_SIZE = FEN_CHARACTERS.length + 2;
export const CLASS_TOKEN = INPUT_VOCAB_SIZE - 2;
export const PAD_TOKEN = INPUT_VOCAB_SIZE - 1;
export const FEN_SEQUENCE_LENGTH = CM.fenTokens;

function charToken(ch: string): number {
	const id = CHAR_INDEX.get(ch);
	if (id === undefined) throw new RangeError(`chessmimic tokeniser: unknown character "${ch}"`);
	return id;
}

/** `[side][64 board squares][castling ×4][ep ×2][halfmove ×3][fullmove ×3][CLASS]` = 78 tokens. */
export function tokenizeFen(fen: string): number[] {
	const [board = "", side = "w", castling = "-", ep = "-", half = "0", full = "1"] = fen
		.trim()
		.split(/\s+/);
	const out: number[] = [];
	for (const ch of side + board.replace(/\//g, "")) {
		if (ch >= "1" && ch <= "8") for (let i = 0; i < Number(ch); i++) out.push(DOT);
		else out.push(charToken(ch));
	}
	if (castling === "-") out.push(DOT, DOT, DOT, DOT);
	else {
		for (const ch of castling) out.push(charToken(ch));
		for (let i = castling.length; i < 4; i++) out.push(DOT);
	}
	if (ep === "-") out.push(DOT, DOT);
	else for (const ch of ep) out.push(charToken(ch));
	for (const field of [half, full]) {
		const padded = field + ".".repeat(Math.max(0, 3 - field.length));
		for (const ch of padded) out.push(charToken(ch));
	}
	out.push(CLASS_TOKEN);
	if (out.length !== FEN_SEQUENCE_LENGTH)
		throw new RangeError(`chessmimic tokeniser: ${out.length} tokens for "${fen}"`);
	return out;
}

// ---------------------------------------------------------------------------
// UCI move vocabulary (searchless_chess `_compute_all_possible_actions`)
// ---------------------------------------------------------------------------

const FILES = "abcdefgh";

function squareName(i: number): string {
	return `${FILES.charAt(i % 8)}${Math.floor(i / 8) + 1}`;
}

/** 1 792 queen/knight moves + 176 promotions = 1 968 entries (order documented above). */
export function buildMoveVocabulary(): string[] {
	const moves: string[] = [];
	for (let s = 0; s < 64; s++) {
		const f = s % 8;
		const r = Math.floor(s / 8);
		const queen: number[] = [];
		const knight: number[] = [];
		for (let t = 0; t < 64; t++) {
			if (t === s) continue;
			const tf = t % 8;
			const tr = Math.floor(t / 8);
			const df = Math.abs(tf - f);
			const dr = Math.abs(tr - r);
			if (tf === f || tr === r || df === dr) queen.push(t);
			if ((df === 1 && dr === 2) || (df === 2 && dr === 1)) knight.push(t);
		}
		for (const t of [...queen, ...knight]) moves.push(squareName(s) + squareName(t));
	}
	for (const [rank, next] of [
		["2", "1"],
		["7", "8"],
	] as const) {
		for (let i = 0; i < 8; i++) {
			const file = FILES.charAt(i);
			const targets = [file];
			if (i > 0) targets.push(FILES.charAt(i - 1));
			if (i < 7) targets.push(FILES.charAt(i + 1));
			for (const tf of targets)
				for (const piece of ["q", "r", "b", "n"]) moves.push(`${file}${rank}${tf}${next}${piece}`);
		}
	}
	if (moves.length !== CM.moveVocabSize)
		throw new RangeError(
			`chessmimic vocabulary: ${moves.length} entries, expected ${CM.moveVocabSize}`
		);
	return moves;
}

export const MOVE_VOCABULARY: readonly string[] = buildMoveVocabulary();
export const MOVE_TO_ACTION: ReadonlyMap<string, number> = new Map(
	MOVE_VOCABULARY.map((m, i) => [m, i])
);

/** Last 12 moves, oldest → newest, left-padded with `PAD_TOKEN`; unknown moves also pad. */
export function encodeRecentMoves(moves: readonly string[]): number[] {
	const n = CM.recentMoves;
	const window = moves.slice(-n);
	const out = new Array<number>(n).fill(PAD_TOKEN);
	window.forEach((m, i) => {
		out[n - window.length + i] = MOVE_TO_ACTION.get(m) ?? PAD_TOKEN;
	});
	return out;
}
