/**
 * Selection: prefer a safe book move unless repetition, conversion or mate guards veto it;
 * otherwise select from the evaluated candidates (or fall back to a legal bestmove when no line
 * is usable).
 */

import { isLoneKing } from "@core/chess/material";
import { phase as phaseOf } from "@core/chess/phase";
import { legalMoves, parseUci, uciToSan } from "@core/chess/san";
import type { AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import type { PolicyResult } from "@core/policy/types";
import { isTrap, lineFacts } from "@core/strength/book/book-policy";
import { conversionPool, isImmediateMate } from "@core/strength/conversion";
import { effectiveElo } from "@core/strength/elo-map";
import { selectMove } from "@core/strength/move-selector";
import { avoidRepetition, repetitionRisk } from "@core/strength/repetition";
import type { SelectionContext } from "@core/strength/types";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import { errorMessage } from "@core/util/errors";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";

import { remainingClockMs } from "../clock";
import { usableLines } from "./lines";
import type { MaiaEloContext } from "./own-move";
import type { RecommendationInput } from "./types";

/**
 * The book move after the conversion, mate and repetition guards; `null` when one vetoes it (or
 * there was none). The trap check is separate: a trapped book move remains the fallback answer.
 */
function guardedBookMove(
	input: RecommendationInput,
	lines: EvalLine[],
	bookMove: ChosenMove | null
): ChosenMove | null {
	let book = bookMove;
	const converting = conversionPool(lines, {
		fen: input.snapshot.fen,
		phase: phaseOf(input.snapshot.fen) ?? "middlegame",
		...(input.history ? { history: input.history } : {}),
	}).active;
	const mateAvailable = lines.some(
		(line) => (line.score.mate ?? 0) > 0 || isImmediateMate(input.snapshot.fen, line.pvUci[0] ?? "")
	);
	if (converting || mateAvailable) book = null;
	// Include an unsearched book candidate in the draw check. Its optimistic score is only
	// for this veto; an actual alternative must still come from a legal evaluated engine line.
	const guardLines =
		book && !lines.some((line) => line.pvUci[0] === book?.uci)
			? [
					...lines,
					{
						multipv: 0,
						depth: 0,
						score: lines[0]?.score ?? { cp: 0 },
						pvUci: [book.uci],
						pvSan: [book.san],
					},
				]
			: lines;
	const guarded = book ? avoidRepetition(guardLines, input.snapshot.fen, input.history) : null;
	if (book && guarded?.avoided && input.history && repetitionRisk(input.history, book.uci) > 0)
		book = null;
	return book;
}

/**
 * No usable line: the engine's legal bestmove, or in a clock race with a lone king any legal
 * move, rather than nothing. `book` when neither exists.
 */
function fallbackMove(
	input: RecommendationInput,
	analysis: AnalysisResult | null,
	book: ChosenMove | null
): ChosenMove | null {
	const fen = input.snapshot.fen;
	const color = input.snapshot.myColor;
	const legal = legalMoves(fen);
	const engineMove = analysis?.bestmove;
	let uci = engineMove && legal.includes(engineMove) ? engineMove : undefined;
	const race =
		color &&
		clockRacePolicy({
			ownClockMs: remainingClockMs(input.snapshot, color, input.nowMs),
			opponentClockMs: remainingClockMs(input.snapshot, color === "w" ? "b" : "w", input.nowMs),
			baseMs: input.snapshot.timeControl?.baseMs ?? 0,
			incrementMs: input.snapshot.timeControl?.incMs ?? 0,
			loneKing: isLoneKing(fen, color),
		});
	if (!uci && color && race && isLoneKing(fen, color)) uci = legal[0];
	const parts = uci && parseUci(uci);
	if (!uci || !parts) return book;
	return {
		uci,
		san: uciToSan(fen, uci) ?? uci,
		...parts,
		source: "sampled",
		rankInLines: 0,
		quality: {
			kind: "search",
			eligible: false,
			reason: "unknown",
			depth: analysis?.final.depth ?? 0,
			candidates: 0,
		},
		rationale: [
			engineMove === uci
				? "search: legal bestmove before a complete PV"
				: "clock race: legal lone-king fallback while analysis is unavailable",
		],
	};
}

/**
 * Prefer a safe book move unless repetition, conversion or mate guards veto it. Otherwise
 * select from the evaluated candidates.
 */
export function chooseMove(
	input: RecommendationInput,
	lines: EvalLine[],
	bookMove: ChosenMove | null,
	analysis: AnalysisResult | null,
	policy: PolicyResult | null,
	maiaExtra: readonly string[] = [],
	maiaElo: MaiaEloContext | null = null,
	humanFrame = false
): ChosenMove | null {
	const E = effectiveElo(input.targetElo, input.form);
	const book = guardedBookMove(input, lines, bookMove);
	if (book) {
		const facts = lineFacts(book.uci, lines);
		if (!isTrap(E, facts)) return book;
		log.info("recommendation: book move vetoed by the trap check", {
			uci: book.uci,
			loss: facts.lossLowerBound,
		});
	}
	// Keep the candidate pool broad so shorter searches do not strengthen the sampled player.
	const pool = lines;
	if (pool.length === 0) return fallbackMove(input, analysis, book);
	// Do not guess a player color when constructing clock-sensitive selection inputs.
	const myColor = input.snapshot.myColor;
	if (myColor === null) return book;
	const ctx: SelectionContext = {
		fen: input.snapshot.fen,
		...(input.history ? { history: input.history } : {}),
		targetElo: input.targetElo,
		form: input.form,
		ply: input.snapshot.ply,
		phase: phaseOf(input.snapshot.fen, input.snapshot.ply) ?? "middlegame",
		myClockMs: remainingClockMs(input.snapshot, myColor, input.nowMs),
		oppClockMs: remainingClockMs(input.snapshot, myColor === "w" ? "b" : "w", input.nowMs),
		selectionMode: input.settings.strength.selectionMode,
		blunderScale: input.settings.strength.blunderScale,
		rng: input.rng,
		state: input.selectionState,
	};
	if (analysis)
		ctx.engineResultKind = analysis.request.elo === undefined ? "unrestricted" : "native-limited";
	if (policy) ctx.maia = policy;
	if (maiaExtra.length > 0) ctx.maiaExtra = maiaExtra;
	// The selector judges candidates at the rating used for the query.
	if (maiaElo) ctx.contextEloPenalty = maiaElo.contextEloPenalty;
	// Only the complete human-depth frame informs generate-and-verify. The main frame
	// remains the evaluation reference.
	const shallow = humanFrame ? analysis?.atFeatureDepth : undefined;
	if (shallow?.complete === true && shallow.lines.length > 0) {
		ctx.shallowLines = usableLines(shallow.lines);
		ctx.shallowDepth = shallow.depth;
		// Compare shallow and main choices for human-depth diagnostics.
		const deepBest = lines[0]?.pvUci[0];
		const shallowBest = ctx.shallowLines[0]?.pvUci[0];
		log.debug("recommendation: human-depth frame", {
			shallowDepth: shallow.depth,
			deepDepth: analysis?.final.depth ?? 0,
			deepBest,
			shallowBest,
			agree: deepBest !== undefined && deepBest === shallowBest,
		});
	}
	// Scale selection pressure by the game's base clock when known; otherwise the blunder
	// model uses its absolute-clock fallback.
	const baseMs = input.snapshot.timeControl?.baseMs ?? 0;
	if (baseMs > 0) ctx.baseMs = baseMs;
	ctx.incrementMs = input.snapshot.timeControl?.incMs ?? 0;
	const last = input.moves[input.moves.length - 1];
	if (last !== undefined) ctx.lastMove = last;
	const bestmove = analysis?.bestmove;
	if (bestmove) ctx.engineBestmove = bestmove;
	try {
		return selectMove(pool, ctx);
	} catch (error) {
		log.warn("recommendation: selection failed", { error: errorMessage(error) });
		return book;
	}
}

/**
 * An incomplete search cannot measure the chosen move's loss: drop the sample and mark the
 * quality ineligible (a book or tablebase move keeps its own).
 */
export function markIncompleteSearch(
	chosen: ChosenMove,
	analysis: AnalysisResult | null,
	candidates: number
): void {
	if (
		!analysis ||
		analysis.final.complete ||
		chosen.source === "book" ||
		chosen.source === "tablebase"
	)
		return;
	delete chosen.cpLoss;
	chosen.quality = {
		kind: "search",
		eligible: false,
		reason: "incomplete",
		depth: analysis.final.depth,
		candidates,
	};
}
