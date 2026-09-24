/**
 * The Lichess tablebase API's answer (`GET TABLEBASE_ENDPOINT?fen=…`), validated into a small typed
 * shape. Everything the network hands us is untrusted: an unknown category, a malformed move or a
 * non-numeric distance drops that entry (or the whole answer), never throws.
 *
 * Categories are Syzygy's WDL with the 50-move rule folded in, from the side to move's point of
 * view: `win`/`loss` (decisive under the rule), `cursed-win`/`blessed-loss` (decisive without the
 * rule, drawn with it), `maybe-win`/`maybe-loss` (decisive, but DTZ rounding leaves the 50-move
 * verdict open), `syzygy-win`/`syzygy-loss` (newer API spelling of the same), `draw` and `unknown`.
 * A move's category is the position **after** the move, i.e. the opponent's point of view.
 */

import { loadPosition } from "@core/chess/fen";
import { TABLEBASE } from "@core/constants/tablebase";

export type TablebaseCategory =
	| "win"
	| "syzygy-win"
	| "maybe-win"
	| "cursed-win"
	| "draw"
	| "blessed-loss"
	| "maybe-loss"
	| "syzygy-loss"
	| "loss"
	| "unknown";

const CATEGORIES: ReadonlySet<string> = new Set<TablebaseCategory>([
	"win",
	"syzygy-win",
	"maybe-win",
	"cursed-win",
	"draw",
	"blessed-loss",
	"maybe-loss",
	"syzygy-loss",
	"loss",
	"unknown",
]);

export interface TablebaseMove {
	uci: string;
	/** The position after the move, from the opponent's point of view. */
	category: TablebaseCategory;
	/** Plies to the next zeroing move after this move (signed, opponent's view); `null` unknown. */
	dtz: number | null;
	/** Whether `dtz` is exact rather than rounded by the table. */
	preciseDtz: boolean;
	/** Plies to mate after this move (signed, opponent's view), ≤ 5 men only; `null` otherwise. */
	dtm: number | null;
	/** The move resets the half-move clock (a capture or a pawn move). */
	zeroing: boolean;
	checkmate: boolean;
	stalemate: boolean;
}

export interface TablebaseProbe {
	/** The position's own category, side to move's view. */
	category: TablebaseCategory;
	/** Every legal move the tables answered, in the API's order. */
	moves: TablebaseMove[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCategory(v: unknown): v is TablebaseCategory {
	return typeof v === "string" && CATEGORIES.has(v);
}

function intOrNull(v: unknown): number | null {
	return typeof v === "number" && Number.isInteger(v) ? v : null;
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Validate one move entry; `null` drops it. */
function parseMove(v: unknown): TablebaseMove | null {
	if (!isRecord(v)) return null;
	const { uci, category } = v;
	if (typeof uci !== "string" || !UCI_RE.test(uci) || !isCategory(category)) return null;
	const precise = intOrNull(v.precise_dtz);
	const dtz = precise ?? intOrNull(v.dtz);
	return {
		uci,
		category,
		dtz,
		preciseDtz: precise !== null,
		dtm: intOrNull(v.dtm),
		zeroing: v.zeroing === true,
		checkmate: v.checkmate === true,
		stalemate: v.stalemate === true,
	};
}

/** The API's JSON → `TablebaseProbe`, or `null` when the answer is unusable. */
export function parseProbe(json: unknown): TablebaseProbe | null {
	if (!isRecord(json) || !isCategory(json.category) || !Array.isArray(json.moves)) return null;
	const moves: TablebaseMove[] = [];
	for (const entry of json.moves) {
		const move = parseMove(entry);
		if (move) moves.push(move);
	}
	return { category: json.category, moves };
}

/** Men on the board, kings included; `null` for a malformed FEN. */
export function pieceCount(fen: string): number | null {
	const placement = fen.trim().split(/\s+/)[0];
	if (!placement) return null;
	let n = 0;
	for (const ch of placement) if (/[pnbrqk]/i.test(ch)) n += 1;
	return n;
}

/** Whether the tables can answer `fen`: a legal position with at most `TABLEBASE.maxPieces` men. */
export function inTablebaseRange(fen: string): boolean {
	const n = pieceCount(fen);
	return n !== null && n <= TABLEBASE.maxPieces && loadPosition(fen) !== null;
}

/**
 * The identity a probe is cached and requested under: placement, side to move, castling rights and
 * a legally usable en-passant square, with the counters reset. The tables do not read the counters
 * (the 50-move rule is applied afterwards against the game's own clock, `rankTablebaseMoves`), so
 * one request answers every visit to the position.
 */
export function probeFen(fen: string): string | null {
	const chess = loadPosition(fen);
	if (!chess) return null;
	const [placement, turn, castling, ep] = chess.fen().split(" ");
	if (!placement || !turn || !castling || !ep) return null;
	return `${placement} ${turn} ${castling} ${ep} 0 1`;
}
