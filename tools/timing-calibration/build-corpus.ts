/**
 * tools/timing-calibration/build-corpus.ts — chess.com games → per-move human think times with
 * situation labels.
 *
 *     bun tools/timing-calibration/build-corpus.ts [--games FILE] [--out FILE] [--labels FILE]
 *
 * Reads a `games.jsonl` in the crawl format (`tools/calibration/common.ts` `StoredGame`) and
 * writes
 *
 *   corpus.jsonl   one `CorpusGame` per game (both sides; moves, positions, per-ply labels)
 *   labels.jsonl   one `LabelRow` per (game, ply) — the finetuner's join table (README beside it)
 *   corpus-summary.json   rows per time class × band × split × situation
 *
 * Clock semantics (chess.com PGN): the n-th `[%clk]` is the mover's clock **after** ply n,
 * increment included; so `think = clock before − clock after + increment`, and a side's first
 * move reads its "clock before" as the base (flagged `first`: the site does not run the clock
 * the same way on move one). A premove is recorded as a 0.1 s tick. Lag compensation is folded
 * into the recorded clocks and cannot be separated.
 *
 * The **book** label is what the bot itself knows: the move is in the Polyglot book the product
 * would consult for a player of this rating (`bookOrderFor(E)`: the first book that knows the
 * position, moves with weight share ≥ `BOOK.minWeightShare`), at ply ≤ `BOOK.maxPly`, E ≤
 * `MAIA.eloMax` — the same rules as `createBookPolicy().bookMove` minus the random draw.
 */

import "../lib/defines";
import path from "node:path";
import { material } from "@core/chess/material";
import { phase as phaseOf } from "@core/chess/phase";
import { BOOK, BOOKS, type BookName, THEORY_BOOKS } from "@core/constants/books";
import { MAIA } from "@core/constants/maia";
import { loadBook, type PolyglotBook } from "@core/strength/book/polyglot";
import { bookOrderFor } from "@core/strength/book/sampling";
import { Chess, type Move } from "chess.js";
import { parsePgn, splitFor } from "../calibration/build-corpus";
import type { StoredGame } from "../calibration/common";
import { flagValue } from "../lib/cli";
import { ROOT } from "../lib/paths";
import {
	type CorpusGame,
	JsonlWriter,
	type LabelRow,
	LOW_CLOCK_FRACTION,
	LOW_CLOCK_MS,
	PATHS,
	type PlyLabel,
	PREMOVE_MAX_MS,
	parseControl,
	readJsonl,
	rowsOf,
	type Situation,
	type TimeClass,
} from "./common";

// ── books ────────────────────────────────────────────────────────────────────────────────────

export type BookSet = Record<BookName, PolyglotBook>;

export async function loadBooks(): Promise<BookSet> {
	const read = async (name: BookName) =>
		loadBook(new Uint8Array(await Bun.file(path.join(ROOT, BOOKS.dir, BOOKS[name])).arrayBuffer()));
	return { gm2600: await read("gm2600"), club: await read("club"), theory: await read("theory") };
}

/** The moves the bot's own book would play from `fen` for a player rated `elo`. */
export function botBookMoves(books: BookSet, fen: string, ply: number, elo: number): string[] {
	if (ply > BOOK.maxPly || elo > MAIA.eloMax) return [];
	for (const name of bookOrderFor(elo)) {
		const entries = books[name].lookup(fen);
		if (entries.length === 0) continue;
		const total = entries.reduce((s, e) => s + e.weight, 0);
		return entries
			.filter((e) => e.weight > 0 && e.weight >= BOOK.minWeightShare * total)
			.map((e) => e.uci);
	}
	return [];
}

export function theoryMovesAt(books: BookSet, fen: string): string[] {
	const out = new Set<string>();
	for (const name of THEORY_BOOKS)
		for (const e of books[name].lookup(fen)) if (e.weight > 0) out.add(e.uci);
	return [...out];
}

// ── labels ───────────────────────────────────────────────────────────────────────────────────

const uciOf = (m: Pick<Move, "from" | "to" | "promotion">): string =>
	`${m.from}${m.to}${m.promotion ? m.promotion.toLowerCase() : ""}`;

/** Material balance from `color`'s point of view. */
function balance(fen: string, color: "w" | "b"): number {
	const m = material(fen);
	return m ? (color === "w" ? m.diff : -m.diff) : 0;
}

export function situationOf(
	l: Pick<PlyLabel, "onlyLegal" | "inBook" | "obviousRecapture" | "inCheck">
): Situation {
	if (l.onlyLegal) return "forced";
	if (l.inBook) return "book";
	if (l.obviousRecapture) return "recapture";
	if (l.inCheck) return "check";
	return "ordinary";
}

export interface GameInput {
	uuid: string;
	tc: TimeClass;
	control: string;
	white: { username: string; rating: number };
	black: { username: string; rating: number };
	pgn: string;
}

/** The corpus record of one game; null when the PGN does not replay or has no clocks. */
export function corpusGame(g: GameInput, books: BookSet): CorpusGame | null {
	const tcParsed = parseControl(g.control);
	if (!tcParsed) return null;
	const baseMs = Math.round(tcParsed.baseS * 1000);
	const incMs = Math.round(tcParsed.incS * 1000);
	const parsed = parsePgn(g.pgn);
	if (parsed.sans.length === 0) return null;
	const board = new Chess();
	const fens = [board.fen()];
	const ucis: string[] = [];
	const verboseBefore: Move[][] = [];
	const checkBefore: boolean[] = [];
	try {
		for (const san of parsed.sans) {
			verboseBefore.push(board.moves({ verbose: true }));
			checkBefore.push(board.inCheck());
			const m = board.move(san);
			ucis.push(uciOf(m));
			fens.push(board.fen());
		}
	} catch {
		return null;
	}
	const clocks = parsed.clocksMs;
	if (clocks.every((c) => c === null)) return null;
	const clockAfter = (ply: number): number | null => (ply < 0 ? baseMs : (clocks[ply] ?? null));
	const plies: PlyLabel[] = [];
	for (let ply = 0; ply < ucis.length; ply++) {
		const color = ply % 2 === 0 ? "w" : "b";
		const clockMs = clockAfter(ply - 2);
		const oppClockMs = clockAfter(ply - 1);
		const after = clockAfter(ply);
		if (clockMs === null || oppClockMs === null || after === null) continue;
		const thinkMs = Math.max(0, clockMs - after + incMs);
		const oppBefore = clockAfter(ply - 3);
		const oppThinkMs =
			ply >= 1 && oppBefore !== null ? Math.max(0, oppBefore - oppClockMs + incMs) : null;
		const fen = fens[ply] as string;
		const uci = ucis[ply] as string;
		const legal = verboseBefore[ply] ?? [];
		const played = legal.find((m) => uciOf(m) === uci);
		const capture = played ? played.isCapture() || played.isEnPassant() : false;
		const prevUci = ply >= 1 ? ucis[ply - 1] : undefined;
		const prevTo = prevUci?.slice(2, 4);
		const prevLegal = ply >= 1 ? (verboseBefore[ply - 1] ?? []) : [];
		const prevMove = prevUci ? prevLegal.find((m) => uciOf(m) === prevUci) : undefined;
		const prevCapture = prevMove ? prevMove.isCapture() || prevMove.isEnPassant() : false;
		const recaptureAny = capture && prevTo !== undefined && played?.to === prevTo;
		// The en-passant pawn lands beside the captured one, so a "recapture" of it is on `to`.
		const obviousRecapture =
			recaptureAny &&
			prevCapture &&
			balance(fens[ply + 1] as string, color) >= balance(fens[ply - 1] as string, color);
		const onRecaptureSquare = legal.filter(
			(m) => m.to === prevTo && (m.isCapture() || m.isEnPassant())
		);
		const onlyRecapture = recaptureAny && new Set(onRecaptureSquare.map((m) => m.from)).size === 1;
		const self = color === "w" ? g.white : g.black;
		const inBook = botBookMoves(books, fen, ply, self.rating).includes(uci);
		const inTheory = ply <= BOOK.maxPly && theoryMovesAt(books, fen).includes(uci);
		const onlyLegal = legal.length === 1;
		const inCheck = checkBefore[ply] === true;
		const labels = { onlyLegal, inBook, obviousRecapture, inCheck };
		const clockFrac = baseMs > 0 ? clockMs / baseMs : 1;
		plies.push({
			ply,
			clockMs,
			oppClockMs,
			thinkMs,
			oppThinkMs,
			first: ply < 2,
			situation: situationOf(labels),
			inBook,
			inTheory,
			onlyLegal,
			inCheck,
			recaptureAny,
			obviousRecapture,
			onlyRecapture,
			capture,
			givesCheck: played ? played.san.includes("+") || played.san.includes("#") : false,
			legalMoves: legal.length,
			phase: phaseOf(fen, ply) ?? "middlegame",
			clockFrac,
			lowClock: clockFrac < LOW_CLOCK_FRACTION || clockMs < LOW_CLOCK_MS,
		});
	}
	if (plies.length === 0) return null;
	const side = (s: { username: string; rating: number }) => {
		const player = s.username.toLowerCase();
		return { player, rating: s.rating, split: splitFor(player) };
	};
	return {
		gameId: g.uuid,
		tc: g.tc,
		control: g.control,
		baseMs,
		incMs,
		w: side(g.white),
		b: side(g.black),
		ucis,
		fens,
		plies,
	};
}

export function labelOf(game: CorpusGame): LabelRow[] {
	return rowsOf(game).map((r) => ({
		gameId: r.gameId,
		ply: r.ply,
		color: r.color,
		player: r.player,
		rating: r.rating,
		tc: r.tc,
		control: r.control,
		thinkMs: r.thinkMs,
		clockMs: r.clockMs,
		oppClockMs: r.oppClockMs,
		first: r.first,
		split: r.split,
		situation: r.situation,
		inBook: r.inBook,
		inTheory: r.inTheory,
		onlyLegal: r.onlyLegal,
		inCheck: r.inCheck,
		recaptureAny: r.recaptureAny,
		obviousRecapture: r.obviousRecapture,
		onlyRecapture: r.onlyRecapture,
		capture: r.capture,
		phase: r.phase,
		lowClock: r.lowClock,
		premove: r.thinkMs <= PREMOVE_MAX_MS,
	}));
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

const TIME_CLASSES = new Set(["bullet", "blitz", "rapid"]);

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const gamesFile = flagValue(argv, "games", PATHS.games) ?? PATHS.games;
	const outFile = flagValue(argv, "out", PATHS.corpus) ?? PATHS.corpus;
	const labelsFile = flagValue(argv, "labels", PATHS.labels) ?? PATHS.labels;
	const summaryFile = flagValue(argv, "summary", PATHS.summary) ?? PATHS.summary;
	// `--shard k/n`: only games whose index ≡ k (mod n); run n processes and `cat` the outputs.
	const [shardK, shardN] = (flagValue(argv, "shard", "0/1") ?? "0/1").split("/").map(Number);
	let index = -1;
	const books = await loadBooks();
	const corpus = new JsonlWriter(outFile);
	const labels = new JsonlWriter(labelsFile);
	const summary = new Map<string, number>();
	const seen = new Set<string>();
	let games = 0;
	let skipped = 0;
	let rows = 0;
	for await (const g of readJsonl<StoredGame & { tc?: string }>(gamesFile)) {
		if (seen.has(g.uuid)) continue;
		seen.add(g.uuid);
		index++;
		if (shardN !== undefined && shardN > 1 && index % shardN !== shardK) continue;
		const tc = g.time_class;
		if (!TIME_CLASSES.has(tc)) {
			skipped++;
			continue;
		}
		const game = corpusGame(
			{ uuid: g.uuid, tc, control: g.time_control, white: g.white, black: g.black, pgn: g.pgn },
			books
		);
		if (!game) {
			skipped++;
			continue;
		}
		corpus.write(game);
		for (const l of labelOf(game)) {
			labels.write(l);
			rows++;
			const key = `${l.tc}\t${Math.floor(l.rating / 100) * 100}\t${l.split}\t${l.situation}`;
			summary.set(key, (summary.get(key) ?? 0) + 1);
		}
		games++;
		if (games % 1000 === 0) process.stderr.write(`${games} games, ${rows} rows\n`);
	}
	await corpus.close();
	await labels.close();
	const cells = [...summary.entries()]
		.map(([k, n]) => {
			const [tc, band, split, situation] = k.split("\t");
			return { tc, band: Number(band), split, situation, rows: n };
		})
		.sort((a, b) =>
			`${a.tc}${a.band}${a.split}${a.situation}`.localeCompare(
				`${b.tc}${b.band}${b.split}${b.situation}`
			)
		);
	await Bun.write(
		summaryFile,
		`${JSON.stringify({ source: gamesFile, games, skipped, rows, cells }, null, "\t")}\n`
	);
	console.log(
		`${games} games (${skipped} skipped), ${rows} labelled plies → ${outFile}, ${labelsFile}`
	);
}

if (import.meta.main) await main();
