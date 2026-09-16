/**
 * Move classification — chess.com's Game Review ladder (`MOVE_CLASSIFICATION`,
 * `@core/constants/review`), from review frames only.
 *
 * A *frame* is one complete MultiPV review search of a position. A verdict reads up to three:
 *
 *   before    the position the move was played from — the best move and its expected points,
 *             the runner-up (Great), the other scored roots (Brilliant);
 *   after     the position the move produced — the played move's score, negated, whenever the
 *             move is not one of `before`'s lines (a checkmate or a draw on the board needs none);
 *   previous  the position before the opponent's last move — how much that move handed over
 *             (Miss). Optional; without it there is no Miss.
 *
 *   loss = expectedPoints(best) − expectedPoints(played), for the mover, at the mover's rating
 *
 * Precedence is chess.com's — Book → Brilliant → Great → Miss → Best → Excellent → Good →
 * Inaccuracy → Mistake → Blunder — under the owner's two additions: Forced (the only legal move)
 * first, then Mate (a move of a forced mating sequence). Pure: no engine, no clock, no chrome.
 */

import { loadPosition } from "@core/chess/fen";
import { playUci } from "@core/chess/san";
import type { MoveQuality } from "@core/constants/move-quality";
import { BRILLIANT, MOVE_CLASSIFICATION, REVIEW } from "@core/constants/review";
import { rankedLines } from "@core/strength/quality";
import type { Eval, EvalLine } from "@typedefs/engine";
import {
	type BrilliantTuning,
	type BrilliantVerdict,
	evaluateBrilliant,
	planBrilliant,
	staticExchange,
} from "./brilliant";
import { byRating, expectedPoints, negateScore } from "./expected-points";

/** One complete review search of a position (side-to-move point of view). */
export interface ReviewFrame {
	lines: readonly EvalLine[];
	depth: number;
	/** Explicit incomplete frames cannot grade a move. Omitted for manually authored fixtures. */
	complete?: boolean;
}

export interface MoveQualityInput {
	/** Position before the move. */
	fen: string;
	/** The move, in UCI. */
	uci: string;
	before: ReviewFrame;
	after?: ReviewFrame | undefined;
	previous?: ReviewFrame | undefined;
	/** The mover's rating; absent = the expected-points reference rating. */
	moverRating?: number | undefined;
	/** The move is opening theory (the bundled books know it from this position). */
	inBook?: boolean | undefined;
	/** The mover's move within `BRILLIANT.sequencePlies` passed the brilliant gates (`BrilliantEvidence`). */
	recentSacrifice?: boolean | undefined;
}

/** Every brilliant gate passed — badged, or held back only as the continuation of a sequence. */
export function passedBrilliantGates(verdict: MoveQualityVerdict | null): boolean {
	const brilliant = verdict?.brilliant;
	return (
		brilliant !== null &&
		brilliant !== undefined &&
		(brilliant.brilliant || brilliant.reason === "continuation")
	);
}

export interface MoveQualityVerdict {
	quality: MoveQuality;
	/** Expected points given up against the best move, in [0, 1]. */
	loss: number;
	bestPoints: number;
	playedPoints: number;
	/** The engine's first choice (or a move scoring exactly as well). */
	top: boolean;
	/** The shallowest frame the verdict rests on. */
	depth: number;
	/**
	 * Moves to checkmate for the mover, this move included (1 = the move is checkmate), when the
	 * move keeps a forced mate; `null` otherwise. Such a move is rated `mate`.
	 */
	mateIn: number | null;
	/** The brilliant gates' answer when the move offered material (diagnostics). */
	brilliant: BrilliantVerdict | null;
}

export type ClassificationTuning = { readonly [K in keyof typeof MOVE_CLASSIFICATION]: number };

export interface MoveQualityTuning {
	classification: ClassificationTuning;
	brilliant: BrilliantTuning;
}

export const DEFAULT_MOVE_QUALITY_TUNING: MoveQualityTuning = {
	classification: MOVE_CLASSIFICATION,
	brilliant: BRILLIANT,
};

/**
 * The only legal move: there was nothing to choose, so nothing is graded (no points, no depth).
 * Needs no review frame — the reporter rates such a move the moment it lands.
 */
export function forcedMoveVerdict(): MoveQualityVerdict {
	return {
		quality: "forced",
		loss: 0,
		bestPoints: 0,
		playedPoints: 0,
		top: true,
		depth: 0,
		mateIn: null,
		brilliant: null,
	};
}

/** The published bands: Best only at zero loss, a boundary belongs to the more severe band. */
export function ordinaryMoveQuality(
	loss: number,
	top: boolean,
	c: ClassificationTuning = MOVE_CLASSIFICATION
): MoveQuality {
	if (loss >= c.blunderLoss) return "blunder";
	if (loss >= c.mistakeLoss) return "mistake";
	if (loss >= c.inaccuracyLoss) return "inaccuracy";
	if (loss >= c.goodLoss) return "good";
	return top || loss <= c.zeroLossTolerance ? "best" : "excellent";
}

/** Review frames must contain one exact iteration, never the playing selector's merged pool. */
export function reviewLines(frame: ReviewFrame | undefined, minDepth: number): EvalLine[] {
	if (!frame || frame.complete === false || !Number.isInteger(frame.depth) || frame.depth < minDepth)
		return [];
	return rankedLines(
		frame.lines.filter((line) => line.depth === frame.depth && expectedPoints(line.score) !== null)
	);
}

function scoredTop(frame: ReviewFrame | undefined, minDepth: number): EvalLine | null {
	const top = reviewLines(frame, minDepth)[0];
	return top && top.depth >= minDepth ? top : null;
}

/**
 * The verdict for `uci` played in `fen`, or `null` when the frames cannot support one: an illegal
 * move, no exact best line, a frame shallower than `minDepth`, or a move neither frame scores.
 */
export function classifyMoveQuality(
	input: MoveQualityInput,
	tuning: MoveQualityTuning = DEFAULT_MOVE_QUALITY_TUNING
): MoveQualityVerdict | null {
	const c = tuning.classification;
	const board = loadPosition(input.fen);
	if (!board || board.isGameOver()) return null;
	const legal = board.moves({ verbose: true });
	const legalSet = new Set(legal.map((m) => m.from + m.to + (m.promotion ?? "")));
	if (!legalSet.has(input.uci)) return null;
	// Forced (owner, 2026-09-15): the only legal move is rated before anything else, frames or not.
	if (legal.length === 1) return forcedMoveVerdict();
	const ranked = reviewLines(input.before, c.minDepth).filter((line) =>
		legalSet.has(line.pvUci[0] ?? "")
	);
	const best = ranked[0];
	if (!best || best.depth < c.minDepth) return null;
	const rating = input.moverRating;
	const bestPoints = expectedPoints(best.score, rating);
	if (bestPoints === null) return null;

	const afterBoard = loadPosition(input.fen);
	const move = afterBoard ? playUci(afterBoard, input.uci) : null;
	if (!afterBoard || !move) return null;
	const terminal: Eval | null = afterBoard.isCheckmate()
		? { mate: 1 }
		: afterBoard.isDraw()
			? { cp: 0 }
			: null;
	const playedLine = ranked.find((line) => line.pvUci[0] === input.uci);
	let playedScore: Eval;
	let playedDepth: number;
	let playedPv: readonly string[] = [input.uci];
	// UCI counts mate in the side to move's moves: `mate n` on the move's own line includes the
	// move, `mate -n` at the position it made counts only the moves still to come.
	let mateIn: number | null = null;
	if (terminal) {
		playedScore = terminal;
		playedDepth = best.depth;
		if (terminal.mate !== undefined) mateIn = 1;
	} else if (playedLine) {
		playedScore = playedLine.score;
		playedDepth = playedLine.depth;
		playedPv = playedLine.pvUci;
		if ((playedLine.score.mate ?? 0) > 0) mateIn = playedLine.score.mate ?? null;
	} else {
		const reply = scoredTop(input.after, c.minDepth);
		if (
			!reply ||
			!afterBoard
				.moves({ verbose: true })
				.some((m) => m.from + m.to + (m.promotion ?? "") === reply.pvUci[0])
		)
			return null;
		playedScore = negateScore(reply.score);
		playedDepth = reply.depth;
		playedPv = [input.uci, ...reply.pvUci];
		if ((reply.score.mate ?? 0) < 0) mateIn = 1 - (reply.score.mate ?? 0);
	}
	const playedPoints = expectedPoints(playedScore, rating);
	if (playedPoints === null) return null;
	const loss = Math.max(0, bestPoints - playedPoints);
	const top = best.pvUci[0] === input.uci || loss <= c.zeroLossTolerance;
	// Great and Brilliant compare moves with each other rather than grade a loss, and chess.com is
	// "more generous" with both for newer players. On the rating-scaled curve a stronger player's
	// gaps grow faster than any threshold could rise, so those comparisons use the reference curve
	// and only their thresholds move with the rating.
	const refPlayed = expectedPoints(playedScore) ?? playedPoints;
	const refLoss = Math.max(0, (expectedPoints(best.score) ?? bestPoints) - refPlayed);
	const alternatives = ranked
		.filter((line) => line.pvUci[0] !== input.uci)
		.flatMap((line) => {
			const points = expectedPoints(line.score);
			return points === null
				? []
				: [{ uci: line.pvUci[0] ?? "", points, mate: line.score.mate, depth: line.depth }];
		});
	const specialEvidence =
		Math.min(best.depth, playedDepth) >= REVIEW.specialDepth &&
		Math.abs(best.depth - playedDepth) <= REVIEW.specialDepthTolerance &&
		alternatives.length > 0;

	let brilliant: BrilliantVerdict | null = null;
	const settle = (quality: MoveQuality): MoveQualityVerdict => ({
		quality,
		loss,
		bestPoints,
		playedPoints,
		top,
		depth: Math.min(best.depth, playedDepth),
		mateIn,
		brilliant,
	});

	// The brilliant gates run whenever the move offers material — also under a Mate or Book
	// rating, so the verdict still says whether the sacrifice itself was sound.
	if (!terminal || terminal.mate !== undefined) {
		const plan = planBrilliant(
			{ fen: input.fen, uci: input.uci, inBook: input.inBook },
			tuning.brilliant
		);
		if (plan && (plan.offers.length > 0 || !plan.materialComplete))
			brilliant = !specialEvidence
				? { brilliant: false, reason: "insufficient-evidence", offers: plan.offers }
				: evaluateBrilliant(
						plan,
						{
							playedPoints: refPlayed,
							ratedPlayedPoints: playedPoints,
							// Moves to mate counting the move itself, comparable with the other roots' `mate n`.
							playedMate: mateIn ?? playedScore.mate,
							playedPv,
							loss: refLoss,
							ratedLoss: loss,
							recentSacrifice: input.recentSacrifice,
							alternatives,
							moverRating: rating,
						},
						tuning.brilliant
					);
	}

	// Mate (owner, 2026-09-14): every move of a forced mating sequence, the checkmate included,
	// outranks the whole ladder.
	if (mateIn !== null) return settle("mate");

	// Book: theory is recognised rather than graded — unless it is a trap that loses real points.
	if (input.inBook === true && loss < c.bookMaxLoss) return settle("book");

	// Brilliant: a sound sacrifice the player chose.
	if (brilliant?.brilliant) return settle("brilliant");

	// Great: the best move, and the only good one.
	const runnerUp = alternatives[0];
	if (
		top &&
		specialEvidence &&
		!terminal &&
		legal.length >= 2 &&
		runnerUp !== undefined &&
		refPlayed >= c.greatMinAfter &&
		runnerUp.points <= c.greatMaxAlternative &&
		refPlayed - runnerUp.points >= byRating(c.greatGapNovice, c.greatGapExpert, rating) &&
		!(move.captured && (staticExchange(input.fen, input.uci, tuning.brilliant) ?? 0) > 0)
	)
		return settle("great");

	// Miss: the opponent's last move handed over a win, and this move handed it back.
	const previous = scoredTop(input.previous, c.minDepth);
	const previousPoints = previous ? expectedPoints(negateScore(previous.score), rating) : null;
	if (
		previousPoints !== null &&
		bestPoints >= c.winningPoints &&
		previousPoints < c.winningPoints &&
		bestPoints - previousPoints >= c.missMinOpportunity &&
		playedPoints < c.winningPoints &&
		loss >= c.missMinLoss &&
		playedPoints >= previousPoints - c.missMaxWorsening
	)
		return settle("miss");

	return settle(ordinaryMoveQuality(loss, top, c));
}
