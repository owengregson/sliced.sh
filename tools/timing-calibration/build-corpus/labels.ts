/**
 * tools/timing-calibration/build-corpus/labels.ts — one game to its corpus record: the moves and
 * positions replayed with chess.js, and per ply with a readable clock the think (`clock before −
 * clock after + increment`, a side's first move reading the base), the opponent's think, the
 * situation and every label the statistics and the finetuner read.
 */

import { material } from "@core/chess/material";
import { phase as phaseOf } from "@core/chess/phase";
import { BOOK } from "@core/constants/books";
import { Chess, type Move } from "chess.js";
import { parsePgn, splitFor } from "../../calibration/build-corpus";
import {
	type CorpusGame,
	type LabelRow,
	LOW_CLOCK_FRACTION,
	LOW_CLOCK_MS,
	type PlyLabel,
	PREMOVE_MAX_MS,
	parseControl,
	rowsOf,
	type Situation,
	type TimeClass,
} from "../common";
import { type BookSet, botBookMoves, theoryMovesAt } from "./books";

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
