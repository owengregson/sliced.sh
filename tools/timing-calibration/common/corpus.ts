/**
 * tools/timing-calibration/common/corpus.ts — the corpus shapes: a game of `corpus.jsonl`, the
 * per-ply labels, the situation of a move, the rows the statistics and the replay read
 * (`rowsOf`), and the `labels.jsonl` rows the finetuner joins on.
 */

import { type TimeClass, tcGroupOf } from "./bands";

export type Split = "fit" | "holdout";

/**
 * The situation of a move, most specific first (`situationOf`). Mutually exclusive, so every row
 * belongs to exactly one:
 *
 *   forced     the only legal move
 *   book       the move is in the opening book the bot itself plays from at this rating
 *              (`bookOrderFor(E)`, first book that knows the position, weight share ≥
 *              `BOOK.minWeightShare`, ply ≤ `BOOK.maxPly`, E ≤ `MAIA.eloMax`)
 *   recapture  an obvious recapture: the opponent's last move captured on square s, this move
 *              captures back on s, and the exchange restores the material balance from before
 *              their capture (≥ it, our point of view)
 *   check      we are in check (with more than one legal reply)
 *   ordinary   everything else
 */
export const SITUATIONS = ["forced", "book", "recapture", "check", "ordinary"] as const;
export type Situation = (typeof SITUATIONS)[number];

/** One side of a corpus game. */
export interface SideInfo {
	player: string;
	rating: number;
	split: Split;
	/**
	 * The crawl kept this side for its cells and per-player caps (`whiteKept`/`blackKept`); an
	 * opponent side stored only because the other was kept is `false`. Absent (the calibration
	 * corpus) = kept.
	 */
	kept?: boolean;
}

/**
 * One game of `corpus.jsonl`: the moves, the positions and one `PlyLabel` per ply that has a
 * readable clock. Rows (`rowsOf`) are expanded in memory so the file stays compact.
 */
export interface CorpusGame {
	gameId: string;
	tc: TimeClass;
	/** The chess.com control string (`"180+2"`). */
	control: string;
	baseMs: number;
	incMs: number;
	w: SideInfo;
	b: SideInfo;
	/** UCI per ply. */
	ucis: string[];
	/** FEN before each ply, plus the final position (empty in the big crawl's `corpus.jsonl`). */
	fens: string[];
	plies: PlyLabel[];
}

/** The per-move labels (not exclusive, except `situation`). */
export interface PlyLabel {
	/** Plies played before this move (0 = White's first move). */
	ply: number;
	/** Own clock before the move (ms). */
	clockMs: number;
	oppClockMs: number;
	/** previous own clock − clock after the move + increment (ms, 100 ms resolution). */
	thinkMs: number;
	/** The opponent's think on the move just before this one (ms), or null (first move). */
	oppThinkMs: number | null;
	/** The side's first move: chess.com's clock semantics make its think unreliable. */
	first: boolean;
	situation: Situation;
	inBook: boolean;
	/** The move is master theory / named theory (`THEORY_BOOKS`), the review's Book. */
	inTheory: boolean;
	onlyLegal: boolean;
	inCheck: boolean;
	/** The production feature `is_recapture`: captures on the square the last move landed on. */
	recaptureAny: boolean;
	/** `situation === "recapture"`'s test regardless of precedence. */
	obviousRecapture: boolean;
	/** Exactly one legal move captures on that square. */
	onlyRecapture: boolean;
	capture: boolean;
	givesCheck: boolean;
	legalMoves: number;
	phase: "opening" | "middlegame" | "endgame";
	/** clock / base. */
	clockFrac: number;
	lowClock: boolean;
}

/** A ply with its game context, as the statistics and the replay read it. */
export interface TimingRow extends PlyLabel {
	id: string;
	gameId: string;
	color: "w" | "b";
	player: string;
	rating: number;
	oppRating: number;
	split: Split;
	tc: TimeClass;
	control: string;
	tcGroup: string;
	baseMs: number;
	incMs: number;
	fen: string;
	move: string;
}

/** Every labelled ply of `game` as a row. */
export function rowsOf(game: CorpusGame): TimingRow[] {
	return game.plies.map((p) => {
		const color = p.ply % 2 === 0 ? "w" : "b";
		const self = game[color];
		const opp = game[color === "w" ? "b" : "w"];
		return {
			...p,
			id: `${game.gameId}:${p.ply}`,
			gameId: game.gameId,
			color,
			player: self.player,
			rating: self.rating,
			oppRating: opp.rating,
			split: self.split,
			tc: game.tc,
			control: game.control,
			tcGroup: tcGroupOf(game.tc, game.control),
			baseMs: game.baseMs,
			incMs: game.incMs,
			fen: game.fens[p.ply] ?? "",
			move: game.ucis[p.ply] ?? "",
		};
	});
}

/** Rows of `labels.jsonl`, the finetuner's join table on `(gameId, ply)`. */
export type LabelRow = Pick<
	TimingRow,
	| "gameId"
	| "ply"
	| "color"
	| "player"
	| "rating"
	| "tc"
	| "control"
	| "thinkMs"
	| "clockMs"
	| "oppClockMs"
	| "first"
	| "split"
	| "situation"
	| "inBook"
	| "inTheory"
	| "onlyLegal"
	| "inCheck"
	| "recaptureAny"
	| "obviousRecapture"
	| "onlyRecapture"
	| "capture"
	| "phase"
	| "lowClock"
> & { premove: boolean; kept?: boolean };
