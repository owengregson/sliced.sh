/**
 * Perfect play from a tablebase probe, against the game's own counters.
 *
 * The tables answer a position without its history, so three things the game knows are applied
 * here rather than trusted to the table: the half-move clock (a table win that zeroes after the
 * 50-move rule has already drawn the game is a draw on chess.com, and a table loss the opponent
 * cannot convert in time is a draw for us), an immediate threefold repetition (a draw whatever the
 * table says), and legality (a move the board does not allow is never returned).
 *
 * Within each outcome the order follows Syzygy's own semantics — Stockfish's `root_probe` ranking,
 * with DTZ as the tiebreak the tables are built for:
 *
 * - **win**: checkmate first, then the fastest conversion (plies to the zeroing move counted from
 *   the root, 1 for a zeroing move), then the shortest known mate (DTM, ≤ 5 men), so a won position
 *   is always driven to its next capture or pawn move inside the 50-move budget;
 * - **cursed win, draw, blessed loss**: every move keeps the result, so the engine's own
 *   preference among them decides (it keeps the practical chances a person would);
 * - **loss**: the longest resistance — the latest zeroing move, then the longest mate.
 */

import { type PositionHistory, positionKey, replayHistory } from "@core/chess/history";
import { legalMoves, playUci } from "@core/chess/san";
import { TABLEBASE } from "@core/constants/tablebase";
import type { Chess } from "chess.js";
import type { TablebaseCategory, TablebaseMove, TablebaseProbe } from "./probe";

/** A move's result for the side playing it, with the 50-move rule and repetition applied. */
export type TablebaseOutcome = "win" | "cursed-win" | "draw" | "blessed-loss" | "loss";

/** Best result first; the tiers `rankTablebaseMoves` sorts by. */
const OUTCOME_TIER: Readonly<Record<TablebaseOutcome, number>> = {
	win: 4,
	"cursed-win": 3,
	draw: 2,
	"blessed-loss": 1,
	loss: 0,
};

export interface RankedTablebaseMove {
	uci: string;
	outcome: TablebaseOutcome;
	/**
	 * Plies from the root to the next zeroing move along this move (1 when the move itself
	 * zeroes); `null` when the table gave no distance.
	 */
	zeroingPlies: number | null;
	/** Plies to mate after the move, when the table knows it (≤ 5 men). */
	mateInPlies: number | null;
	checkmate: boolean;
	/** The move returns to a position already seen this game (not yet a threefold). */
	repeats: boolean;
}

export interface TablebaseAnswer {
	/** The best move: `ranked[0]`. */
	best: RankedTablebaseMove;
	/** Every legal answered move, best first. */
	ranked: RankedTablebaseMove[];
	/** The position's result for the side to move under perfect play (`best.outcome`). */
	outcome: TablebaseOutcome;
}

export interface RankInput {
	/** The position the probe answers (full FEN; its counters are ignored when `history` replays). */
	fen: string;
	probe: TablebaseProbe;
	/** The game's validated history, for the true half-move clock and repetitions. */
	history?: PositionHistory | undefined;
	/** The engine's preferred first moves, best first: the tiebreak inside a drawn tier. */
	enginePreference?: readonly string[] | undefined;
}

/** The mover's result as the table states it (a move's category is the opponent's view). */
function moverOutcome(
	category: TablebaseCategory
): { outcome: TablebaseOutcome; exact: boolean } | null {
	switch (category) {
		case "loss":
		case "syzygy-loss":
			return { outcome: "win", exact: true };
		case "maybe-loss":
			return { outcome: "win", exact: false };
		case "blessed-loss":
			return { outcome: "cursed-win", exact: true };
		case "draw":
			return { outcome: "draw", exact: true };
		case "cursed-win":
			return { outcome: "blessed-loss", exact: true };
		case "win":
		case "syzygy-win":
			return { outcome: "loss", exact: true };
		case "maybe-win":
			return { outcome: "loss", exact: false };
		case "unknown":
			return null;
	}
}

/**
 * The game replayed to `fen`, or `null` when the history does not reach it. Positions are compared
 * without their counters: a board read from the DOM carries heuristic ones (`approximate`), and
 * the replay is exactly what supplies the true clock then.
 */
function replayTo(fen: string, history: PositionHistory | undefined): Chess | null {
	const replayed = history ? replayHistory(history) : null;
	return replayed && positionKey(replayed.fen()) === positionKey(fen) ? replayed : null;
}

/** The half-move clock of `fen`, from the replayed history when it reaches the position. */
function halfmoveClock(fen: string, replayed: Chess | null): number {
	const field = (replayed?.fen() ?? fen).trim().split(/\s+/)[4];
	const n = Number(field);
	return Number.isInteger(n) && n >= 0 ? n : 0;
}

interface RepetitionFacts {
	/** Playing the move completes a threefold repetition (chess.com draws it at once). */
	threefold: boolean;
	/** The move reaches a position already on the board earlier this game. */
	repeats: boolean;
}

/** Every candidate against one replay; `null` without a replay that reaches the position. */
function repetitionFacts(
	chess: Chess | null,
	moves: readonly string[]
): Map<string, RepetitionFacts> | null {
	if (!chess) return null;
	const seen = new Set(chess.history({ verbose: true }).map((m) => positionKey(m.before)));
	seen.add(positionKey(chess.fen()));
	const out = new Map<string, RepetitionFacts>();
	for (const uci of moves) {
		if (!playUci(chess, uci)) continue;
		out.set(uci, {
			threefold: !chess.isCheckmate() && chess.isThreefoldRepetition(),
			repeats: seen.has(positionKey(chess.fen())),
		});
		chess.undo();
	}
	return out;
}

/** One answered move, judged against the game's counters. */
function judge(
	move: TablebaseMove,
	clock: number,
	repetition: RepetitionFacts | undefined
): RankedTablebaseMove | null {
	const base = {
		uci: move.uci,
		checkmate: move.checkmate,
		repeats: repetition?.repeats === true,
		mateInPlies: move.dtm === null ? null : Math.abs(move.dtm),
	};
	if (move.checkmate) return { ...base, outcome: "win", zeroingPlies: 0 };
	const stated = move.stalemate
		? { outcome: "draw" as const, exact: true }
		: moverOutcome(move.category);
	if (!stated) return null;
	const after = move.zeroing ? 0 : clock + 1;
	const zeroingPlies = move.zeroing ? 1 : move.dtz === null ? null : Math.abs(move.dtz) + 1;
	let outcome: TablebaseOutcome = stated.outcome;
	// The rule has already drawn the game when the move leaves the clock at its limit.
	if (after >= TABLEBASE.fiftyMovePlies || repetition?.threefold === true) outcome = "draw";
	else if (move.dtz !== null && (outcome === "win" || outcome === "loss")) {
		const exact = stated.exact && move.preciseDtz;
		const reach = after + Math.abs(move.dtz);
		const margin = exact ? 0 : TABLEBASE.roundedDtzMarginPlies;
		// Our win must zero inside the rule (a rounded distance keeps a ply of margin); the
		// opponent's win likewise, else the rule saves us (a rounded distance is given the benefit).
		if (outcome === "win" && reach > TABLEBASE.fiftyMovePlies - margin) outcome = "cursed-win";
		if (outcome === "loss" && reach > TABLEBASE.fiftyMovePlies + margin) outcome = "blessed-loss";
	}
	return { ...base, outcome, zeroingPlies };
}

const FAR = Number.MAX_SAFE_INTEGER;

/** Ascending comparison of two key tuples. */
function compareKeys(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** The sort key inside one outcome tier (ascending = better). */
function tierKey(m: RankedTablebaseMove, engineRank: number, apiIndex: number): number[] {
	switch (m.outcome) {
		case "win":
			return [
				m.checkmate ? 0 : 1,
				m.zeroingPlies ?? FAR,
				m.repeats ? 1 : 0,
				m.mateInPlies ?? FAR,
				engineRank,
				apiIndex,
			];
		case "loss":
			return [-(m.zeroingPlies ?? 0), -(m.mateInPlies ?? 0), engineRank, apiIndex];
		default:
			return [engineRank, apiIndex];
	}
}

/**
 * Rank every legal move the probe answered; `null` when none survives (an empty or foreign answer,
 * or every move `unknown`).
 */
export function rankTablebaseMoves(input: RankInput): TablebaseAnswer | null {
	const legal = new Set(legalMoves(input.fen));
	if (legal.size === 0) return null;
	const answered = input.probe.moves.filter((m) => legal.has(m.uci));
	const replayed = replayTo(input.fen, input.history);
	const clock = halfmoveClock(input.fen, replayed);
	const repetition = repetitionFacts(
		replayed,
		answered.map((m) => m.uci)
	);
	const preference = input.enginePreference ?? [];
	const scored: { move: RankedTablebaseMove; key: number[] }[] = [];
	answered.forEach((m, apiIndex) => {
		const move = judge(m, clock, repetition?.get(m.uci));
		if (!move) return;
		const engineIndex = preference.indexOf(move.uci);
		const engineRank = engineIndex < 0 ? FAR : engineIndex;
		scored.push({ move, key: [-OUTCOME_TIER[move.outcome], ...tierKey(move, engineRank, apiIndex)] });
	});
	scored.sort((a, b) => compareKeys(a.key, b.key));
	const ranked = scored.map((s) => s.move);
	const best = ranked[0];
	if (!best) return null;
	return { best, ranked, outcome: best.outcome };
}

/** Whether `uci` keeps the position's perfect-play result (`answer.outcome`). */
export function keepsResult(answer: TablebaseAnswer, uci: string): boolean {
	const move = answer.ranked.find((m) => m.uci === uci);
	return move !== undefined && OUTCOME_TIER[move.outcome] >= OUTCOME_TIER[answer.outcome];
}
