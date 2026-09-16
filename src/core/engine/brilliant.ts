/**
 * Brilliant moves — a sound piece sacrifice the player chose (`BRILLIANT`, `@core/constants/review`).
 *
 * Two halves. `planBrilliant` is pure chess and needs no engine: it finds every piece the move
 * leaves to be taken for a real concession (the offers) and whether the player had a safe
 * alternative. `evaluateBrilliant` then applies the engine gates to expected points the move
 * classifier has already computed, so a verdict never searches anything on its own.
 */

import { loadPosition } from "@core/chess/fen";
import { PIECE_VALUES } from "@core/chess/material";
import { playUci } from "@core/chess/san";
import { BRILLIANT } from "@core/constants/review";
import type { Chess, Move } from "chess.js";
import { byRating } from "./expected-points";

export type BrilliantTuning = { readonly [K in keyof typeof BRILLIANT]: number };

export type SacrificeShape =
	| "indirect"
	| "ignored-threat"
	| "hanging-piece"
	| "capture-sacrifice"
	| "exchange-sacrifice";

export interface SacrificeOffer {
	/** The opponent's legal capture after the move, in UCI. */
	capture: string;
	square: string;
	shape: SacrificeShape;
	/** Pawn units the mover loses in the legal exchange on `square`, net of the move's own gain. */
	concession: number;
}

export interface BrilliantPlanInput {
	fen: string;
	uci: string;
	inBook?: boolean | undefined;
}

export interface BrilliantPlan extends BrilliantPlanInput {
	legalMoves: number;
	offers: SacrificeOffer[];
	/** False when a legal exchange exceeded the work bound; absence of proof is not safety. */
	materialComplete: boolean;
	/**
	 * Another legal move gives up less: its worst concession is smaller than this move's. (Not "no
	 * concession at all" — a piece already lost whatever is played does not make a sacrifice forced.)
	 */
	safeAlternative: boolean;
}

/** Another root move and its expected points for the mover. */
export interface BrilliantAlternative {
	uci: string;
	points: number;
	mate?: number | undefined;
}

export interface BrilliantEvidence {
	/** Expected points after the move, for the mover. */
	playedPoints: number;
	/** Soundness at the actual mover's rating; reference points remain the comparison scale. */
	ratedPlayedPoints?: number | undefined;
	/** The played move's score is a mate (sign from the mover's side). */
	playedMate?: number | undefined;
	/** Expected-points loss against the best move (reference curve). */
	loss: number;
	/** The same loss at the mover's rating (`BRILLIANT.nearBestRatedLoss`). */
	ratedLoss?: number | undefined;
	/** Every other scored root move of the same review. */
	alternatives: readonly BrilliantAlternative[];
	/** The engine's line starting with the played move (the illusion test reads it). */
	playedPv?: readonly string[] | undefined;
	moverRating?: number | undefined;
	/**
	 * The same player's move within `BRILLIANT.sequencePlies` already passed these gates: this
	 * sacrifice continues that attack.
	 */
	recentSacrifice?: boolean | undefined;
}

export type BrilliantReason =
	| "illegal"
	| "insufficient-evidence"
	| "book"
	| "forced"
	| "not-sacrifice"
	| "illusion"
	| "no-safe-alternative"
	| "unsound"
	| "not-near-best"
	| "trivial-win"
	| "continuation"
	| "sound-sacrifice";

export interface BrilliantVerdict {
	brilliant: boolean;
	reason: BrilliantReason;
	offers: readonly SacrificeOffer[];
}

function uciOf(move: Move): string {
	return move.from + move.to + (move.promotion ?? "");
}

/** Material a move wins by itself: the captured piece and a promotion's upgrade. */
function gain(move: Move): number {
	return (
		(move.captured ? PIECE_VALUES[move.captured] : 0) +
		(move.promotion ? PIECE_VALUES[move.promotion] - PIECE_VALUES.p : 0)
	);
}

/**
 * What `move`'s side nets from the legal captures on `move.to` that follow, either side free to
 * stop exchanging. `null` when the bounded search gives up.
 */
function exchangeGain(
	board: Chess,
	move: Move,
	tuning: BrilliantTuning,
	budget: { nodes: number },
	plies = 0
): number | null {
	if (++budget.nodes > tuning.maxExchangeNodes || plies >= tuning.maxExchangePlies) return null;
	board.move(move);
	try {
		const legal = board.moves({ verbose: true });
		// A forced recapture cannot be replaced by the usual SEE stand-pat value of zero.
		const canStop =
			legal.length === 0 || legal.some((reply) => !reply.captured || reply.to !== move.to);
		let replyGain = canStop ? 0 : Number.NEGATIVE_INFINITY;
		for (const reply of legal) {
			if (!reply.captured || reply.to !== move.to) continue;
			const value = exchangeGain(board, reply, tuning, budget, plies + 1);
			if (value === null) return null;
			replyGain = Math.max(replyGain, value);
		}
		return gain(move) - replyGain;
	} finally {
		board.undo();
	}
}

/**
 * The static exchange of `uci` itself: the material the move nets on its destination square once
 * the legal captures there are played out. `null` for an illegal move or an exhausted search.
 */
export function staticExchange(
	fen: string,
	uci: string,
	tuning: BrilliantTuning = BRILLIANT
): number | null {
	const board = loadPosition(fen);
	const move = board?.moves({ verbose: true }).find((m) => uciOf(m) === uci);
	if (!board || !move) return null;
	return exchangeGain(board, move, tuning, { nodes: 0 });
}

/** Every piece `candidate` leaves to be taken for a concession — not only the piece that moved. */
function scanOffers(
	fen: string,
	candidate: string,
	tuning: BrilliantTuning
): { offers: SacrificeOffer[]; complete: boolean } {
	const before = loadPosition(fen);
	const board = loadPosition(fen);
	if (!before || !board) return { offers: [], complete: false };
	const moved = playUci(board, candidate);
	if (!moved) return { offers: [], complete: false };
	const offers: SacrificeOffer[] = [];
	let complete = true;
	for (const reply of board.moves({ verbose: true })) {
		if (!reply.captured || PIECE_VALUES[reply.captured] < tuning.minOfferedPiece) continue;
		const value = exchangeGain(board, reply, tuning, { nodes: 0 });
		if (value === null) {
			complete = false;
			continue;
		}
		const concession = value - gain(moved);
		if (concession < tuning.minConcession) continue;
		const indirect = reply.to !== moved.to;
		const shape: SacrificeShape = indirect
			? before.isAttacked(reply.to, reply.color)
				? "ignored-threat"
				: "indirect"
			: moved.piece === "r" && (reply.piece === "b" || reply.piece === "n")
				? "exchange-sacrifice"
				: moved.captured
					? "capture-sacrifice"
					: "hanging-piece";
		offers.push({ capture: uciOf(reply), square: reply.to, shape, concession });
	}
	return { offers, complete };
}

/** No engine work: the offers `uci` makes and whether a safe alternative existed. */
export function planBrilliant(
	input: BrilliantPlanInput,
	tuning: BrilliantTuning = BRILLIANT
): BrilliantPlan | null {
	const board = loadPosition(input.fen);
	if (!board) return null;
	const moves = board.moves({ verbose: true });
	if (!moves.some((move) => uciOf(move) === input.uci)) return null;
	const scan = scanOffers(input.fen, input.uci, tuning);
	const offers = scan.offers;
	const worst = (list: readonly SacrificeOffer[]): number =>
		Math.max(0, ...list.map((offer) => offer.concession));
	const given = worst(offers);
	// Only worth the per-move scan when the move is an offer; `some` stops at the first safer move.
	const safeAlternative =
		offers.length > 0 &&
		moves.some((move) => {
			if (uciOf(move) === input.uci) return false;
			const alternative = scanOffers(input.fen, uciOf(move), tuning);
			return alternative.complete && worst(alternative.offers) < given;
		});
	return {
		...input,
		legalMoves: moves.length,
		offers,
		safeAlternative,
		materialComplete: scan.complete,
	};
}

/** The mover's material minus the opponent's, in pawn units (kings excluded). */
function balance(board: Chess, color: "w" | "b"): number {
	let total = 0;
	for (const row of board.board())
		for (const piece of row)
			if (piece && piece.type !== "k")
				total += (piece.color === color ? 1 : -1) * PIECE_VALUES[piece.type];
	return total;
}

/**
 * An ignored threat that is no gift: along the engine's own line the opponent takes the threatened
 * piece and the mover's very next move wins the material straight back (within
 * `illusionRegainTolerance`), on another square the exchange search does not look at. Only
 * ignored threats — a sacrifice by capture that regains material at once is still a sacrifice.
 */
function regainedAtOnce(
	plan: BrilliantPlan,
	pv: readonly string[],
	tuning: BrilliantTuning
): boolean {
	const [move, reply, answer] = pv;
	if (move !== plan.uci || reply === undefined || answer === undefined) return false;
	if (
		tuning.tradeRegainAnyShape <= 0 &&
		plan.offers.some((offer) => offer.shape !== "ignored-threat")
	)
		return false;
	if (!plan.offers.some((offer) => offer.capture === reply)) return false;
	const board = loadPosition(plan.fen);
	if (!board) return false;
	const color = board.turn();
	if (!playUci(board, move)) return false;
	const afterMove = balance(board, color);
	if (!playUci(board, reply) || !playUci(board, answer)) return false;
	return balance(board, color) >= afterMove - tuning.illusionRegainTolerance;
}

/** The offer is the piece that moved: hung on its new square, capturing, or given for the exchange. */
function offersMovedPiece(offer: SacrificeOffer): boolean {
	return offer.shape !== "ignored-threat" && offer.shape !== "indirect";
}

/** The four gates, over expected points the classifier already holds. */
export function evaluateBrilliant(
	plan: BrilliantPlan,
	evidence: BrilliantEvidence,
	tuning: BrilliantTuning = BRILLIANT
): BrilliantVerdict {
	const verdict = (reason: BrilliantReason): BrilliantVerdict => ({
		brilliant: reason === "sound-sacrifice",
		reason,
		offers: plan.offers,
	});
	// 1. Chosen, or forced?
	if (plan.inBook === true) return verdict("book");
	if (plan.legalMoves < 2) return verdict("forced");
	if (!plan.materialComplete) return verdict("insufficient-evidence");
	// 2. Gift, or illusion?
	if (plan.offers.length === 0) return verdict("not-sacrifice");
	if (tuning.movedPieceOffersOnly > 0 && !plan.offers.some(offersMovedPiece))
		return verdict("not-sacrifice");
	if (evidence.playedPv && regainedAtOnce(plan, evidence.playedPv, tuning))
		return verdict("illusion");
	if (!plan.safeAlternative) return verdict("no-safe-alternative");
	const probability = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;
	const board = loadPosition(plan.fen);
	const legal = new Set(board?.moves({ verbose: true }).map(uciOf));
	if (
		!probability(evidence.playedPoints) ||
		(evidence.ratedPlayedPoints !== undefined && !probability(evidence.ratedPlayedPoints)) ||
		!probability(evidence.loss) ||
		(evidence.ratedLoss !== undefined && !probability(evidence.ratedLoss)) ||
		(evidence.playedMate !== undefined &&
			(!Number.isInteger(evidence.playedMate) || evidence.playedMate === 0)) ||
		evidence.alternatives.length === 0 ||
		evidence.alternatives.some(
			(alt) => !probability(alt.points) || alt.uci === plan.uci || !legal.has(alt.uci)
		)
	)
		return verdict("insufficient-evidence");
	// 3. Holds, or collapses?
	if (
		(evidence.playedMate ?? 0) < 0 ||
		(evidence.ratedPlayedPoints ?? evidence.playedPoints) < tuning.minAfter
	)
		return verdict("unsound");
	const mateElsewhere = evidence.alternatives.some((alt) => (alt.mate ?? 0) > 0);
	const nearBestLoss =
		tuning.nearBestRatedLoss > 0 && evidence.ratedLoss !== undefined
			? evidence.ratedLoss
			: evidence.loss;
	if (
		nearBestLoss > byRating(tuning.maxLossNovice, tuning.maxLossExpert, evidence.moverRating) ||
		(mateElsewhere && (evidence.playedMate ?? 0) <= 0)
	)
		return verdict("not-near-best");
	// 4. Fight, or victory lap?
	const bestAlternative = Math.max(0, ...evidence.alternatives.map((alt) => alt.points));
	// A victory lap means the win was there without giving anything away, so only a plain
	// alternative answers gate 4: a move that sacrifices as well is the same idea with another
	// piece (`sacrificialAlternativeNotTrivial`). `bestAlternative` above keeps every alternative —
	// the continuation test below asks a different question.
	const plainBest =
		tuning.sacrificialAlternativeNotTrivial > 0
			? Math.max(
					0,
					...evidence.alternatives
						.filter((alt) => {
							const scan = scanOffers(plan.fen, alt.uci, tuning);
							// An unproved exchange must not erase evidence of an already available win.
							return !scan.complete || scan.offers.length === 0;
						})
						.map((alt) => alt.points)
				)
			: bestAlternative;
	// The fastest mate is still the move that had to be found, however winning the rest is.
	const playedMate = evidence.playedMate ?? 0;
	const alternativeMates = evidence.alternatives.flatMap((alt) =>
		alt.mate !== undefined && alt.mate > 0 ? [alt.mate] : []
	);
	const fastestMate = playedMate > 0 && alternativeMates.every((mate) => mate >= playedMate);
	const fasterMate = playedMate > 0 && alternativeMates.every((mate) => mate > playedMate);
	// Already winning, and the sacrifice gains nothing on the plain move: a gratuitous one.
	const gratuitous =
		plainBest >= tuning.gratuitousWinning &&
		evidence.playedPoints - plainBest < tuning.gratuitousGain &&
		Math.max(0, ...plan.offers.map((offer) => offer.concession)) <= tuning.gratuitousMaxConcession;
	if (
		(plainBest >= tuning.trivialAlternative || gratuitous) &&
		!(tuning.fastestMateNotTrivial > 0 && fastestMate)
	)
		return verdict("trivial-win");
	// Last, so `continuation` also says every other gate passed (the next move's window reads it).
	// A continuation that is itself the decisive move is a brilliant find of its own.
	const decisive =
		(evidence.playedPoints - bestAlternative >= tuning.sequenceDecisiveGap ||
			(tuning.fasterMateDecisive > 0 && fasterMate)) &&
		(tuning.decisiveNeedsMovedPiece <= 0 ||
			plan.offers.some((offer) => offer.shape !== "ignored-threat" && offer.shape !== "indirect"));
	if (evidence.recentSacrifice === true && !decisive) return verdict("continuation");
	return verdict("sound-sacrifice");
}

export function classifyBrilliant(
	input: BrilliantPlanInput & BrilliantEvidence,
	tuning: BrilliantTuning = BRILLIANT
): BrilliantVerdict {
	const plan = planBrilliant(input, tuning);
	return plan
		? evaluateBrilliant(plan, input, tuning)
		: { brilliant: false, reason: "illegal", offers: [] };
}
