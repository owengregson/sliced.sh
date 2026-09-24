/**
 * tools/timing-calibration/common.ts — shared shapes, paths and cell keys for the think-time
 * calibration (`build-corpus.ts` → `heads.ts` / `frames.ts` → `sim.ts` → `fit.ts` / `verify.ts`).
 * Nothing here runs in the extension.
 */

import path from "node:path";
import { ROOT } from "../lib/paths";

export const DATA_DIR = process.env.SL_TIMING_CALIB_DIR ?? path.join(ROOT, "data/timing/calib");

export const PATHS = {
	/** The default game source: the Maia calibration crawl (chess.com, `[%clk]` per ply). */
	games: path.join(ROOT, "data/calibration/games.jsonl"),
	/** The big timing crawl, once it is large enough (`data/timing/crawl/`). */
	crawlGames: path.join(ROOT, "data/timing/crawl/games.jsonl"),
	corpus: path.join(DATA_DIR, "corpus.jsonl"),
	/** The replayed games only, with FENs (`build_corpus.py --only select.json`). */
	selectGames: path.join(DATA_DIR, "select-games.jsonl"),
	labels: path.join(DATA_DIR, "labels.jsonl"),
	summary: path.join(DATA_DIR, "corpus-summary.json"),
	heads: path.join(DATA_DIR, "heads.jsonl"),
	frames: path.join(DATA_DIR, "frames.jsonl"),
	replay: path.join(DATA_DIR, "replay.jsonl"),
	sim: path.join(DATA_DIR, "sim"),
	fit: path.join(DATA_DIR, "fit"),
	verify: path.join(DATA_DIR, "verify"),
} as const;

export type TimeClass = "bullet" | "blitz" | "rapid";
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

/** chess.com records a premove as a 0.1 s tick: a think at or under this is a premove. */
export const PREMOVE_MAX_MS = 200;
/** Own clock under this fraction of the base, or under `LOW_CLOCK_MS`, is "low clock". */
export const LOW_CLOCK_FRACTION = 0.1;
export const LOW_CLOCK_MS = 10_000;

/** 100-Elo rating bands, 600 … 3000 (3000 = "3000+"; below 600 → 600). */
export const BAND_WIDTH = 100;
export const BAND_MIN = 600;
export const BAND_MAX = 3000;
export function bandOf(rating: number): number {
	const b = Math.floor(rating / BAND_WIDTH) * BAND_WIDTH;
	return Math.min(BAND_MAX, Math.max(BAND_MIN, b));
}

/** Wider bands for reporting (400-Elo: 600, 1000, …, 2600, 3000+). */
export function wideBandOf(rating: number): number {
	if (rating >= 3000) return 3000;
	if (rating < 1000) return 600;
	return 1000 + Math.floor((rating - 1000) / 400) * 400;
}

/**
 * The reporting group of a time control: the class, with rapid split by control (10+0, 15+10,
 * 10+5 mix very different paces) and other rapid controls pooled.
 */
export function tcGroupOf(tc: TimeClass, control: string): string {
	if (tc !== "rapid") return tc;
	if (control === "600" || control === "900+10" || control === "600+5") return `rapid:${control}`;
	return "rapid:other";
}

export const TC_GROUPS = ["bullet", "blitz", "rapid:600", "rapid:600+5", "rapid:900+10"] as const;

/** `"180+2"` → base 180 s, increment 2 s; `"60"` → 60 + 0; null for daily or junk. */
export function parseControl(tc: string): { baseS: number; incS: number } | null {
	const m = /^(\d+)(?:\+(\d+(?:\.\d+)?))?$/.exec(tc.trim());
	if (!m) return null;
	return { baseS: Number(m[1]), incS: m[2] !== undefined ? Number(m[2]) : 0 };
}

/** Read a JSONL file line by line without holding the text twice. */
export async function* readJsonl<T>(file: string, tolerant = false): AsyncGenerator<T> {
	const parse = (line: string): T | undefined => {
		if (!tolerant) return JSON.parse(line) as T;
		try {
			return JSON.parse(line) as T;
		} catch {
			return undefined;
		}
	};
	const reader = Bun.file(file).stream().pipeThrough(new TextDecoderStream()).getReader();
	let rest = "";
	for (;;) {
		const { value: chunk, done } = await reader.read();
		if (done) break;
		rest += chunk;
		let nl = rest.indexOf("\n");
		while (nl >= 0) {
			const line = rest.slice(0, nl);
			rest = rest.slice(nl + 1);
			const v = line.trim() ? parse(line) : undefined;
			if (v !== undefined) yield v;
			nl = rest.indexOf("\n");
		}
	}
	const last = rest.trim() ? parse(rest) : undefined;
	if (last !== undefined) yield last;
}

/** A buffered JSONL writer. */
export class JsonlWriter {
	private readonly sink: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
	constructor(file: string) {
		this.sink = Bun.file(file).writer();
	}
	write(value: unknown): void {
		this.sink.write(`${JSON.stringify(value)}\n`);
	}
	async close(): Promise<void> {
		await this.sink.end();
	}
}
