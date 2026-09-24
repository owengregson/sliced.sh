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
import { byRating, effectiveRating } from "./expected-points";

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
	/**
	 * Taking the moved piece loses at least as much elsewhere, to a capture that already won it
	 * before the offer was accepted (`BRILLIANT.standingThreatMinRating`).
	 */
	standing?: boolean;
	/**
	 * Taking this piece is answered by a capture elsewhere that wins it back with check
	 * (`BRILLIANT.checkRecoveryMinRating`).
	 */
	checkRecovered?: boolean;
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
	/** The same, at the mover's rating (`BRILLIANT.gratuitousRatedWinning`). */
	ratedPoints?: number | undefined;
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
	| "mating-threat"
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

/**
 * Material a move wins by itself: the captured piece and a promotion's upgrade. `pawnsOf` prices
 * that side's pawns at nothing — the piece-only exchange of `BRILLIANT.pawnLossNotSacrifice`.
 */
function gain(move: Move, pawnsOf?: "w" | "b"): number {
	const free = move.captured === "p" && pawnsOf !== undefined && move.color !== pawnsOf;
	return (
		(move.captured && !free ? PIECE_VALUES[move.captured] : 0) +
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
	plies = 0,
	pawnsOf?: "w" | "b"
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
			const value = exchangeGain(board, reply, tuning, budget, plies + 1, pawnsOf);
			if (value === null) return null;
			replyGain = Math.max(replyGain, value);
		}
		return gain(move, pawnsOf) - replyGain;
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

/**
 * An untouched piece is not a gift when taking it permits an immediate, safe countercapture
 * elsewhere. Check the acceptance branch itself: the engine's main PV may decline the offer.
 * Same-square recovery is already counted by exchangeGain. Do not use a capture's face value:
 * the capturing piece may itself be lost. Null means the shared material-search budget ran out.
 * A checking capture counts only with `checks`: same-square SEE cannot follow the evasion.
 */
function hasOffSquareRecovery(
	board: Chess,
	capture: Move,
	tuning: BrilliantTuning,
	budget: { nodes: number },
	standing?: Chess | null,
	checks = false
): boolean | null {
	if (standing === null) return false;
	board.move(capture);
	try {
		const needed = gain(capture);
		for (const answer of board.moves({ verbose: true })) {
			if (!answer.captured || answer.to === capture.to || gain(answer) < needed) continue;
			if (!checks && /[+#]/.test(answer.san)) continue;
			const recovered = exchangeGain(board, answer, tuning, budget);
			if (recovered === null) return null;
			if (recovered < needed) continue;
			if (standing === undefined) return true;
			// The moved piece: only a capture that already won this much before the offer was
			// accepted — a deflection's regain exists because of the acceptance, and is a sacrifice.
			const threat = standing
				.moves({ verbose: true })
				.find((move) => move.from === answer.from && move.to === answer.to);
			if (!threat?.captured) continue;
			const already = exchangeGain(standing, threat, tuning, budget);
			if (already === null) return null;
			if (already >= needed) return true;
		}
		return false;
	} finally {
		board.undo();
	}
}

/** The position with the move handed back to the side that just played; `null` out of a check. */
function passed(board: Chess): Chess | null {
	if (board.isCheck()) return null;
	const fields = board.fen().split(" ");
	fields[1] = board.turn() === "w" ? "b" : "w";
	fields[3] = "-";
	return loadPosition(fields.join(" "));
}

/** A short checking mate proves an ignored piece cannot actually be taken safely. */
function checkingMate(
	board: Chess,
	attacker: "w" | "b",
	plies: number,
	tuning: BrilliantTuning,
	budget: { nodes: number }
): boolean | null {
	if (++budget.nodes > tuning.maxExchangeNodes) return null;
	const moves = board.moves({ verbose: true });
	if (moves.length === 0) return board.isCheck() && board.turn() !== attacker;
	if (plies <= 0) return false;
	const attacking = board.turn() === attacker;
	// Only checking continuations are proof here; a quiet move may have an unexamined defence.
	const candidates = attacking ? moves.filter((move) => /[+#]/.test(move.san)) : moves;
	if (attacking && candidates.some((move) => move.san.endsWith("#"))) return true;
	for (const move of candidates) {
		board.move(move);
		let result: boolean | null;
		try {
			result = checkingMate(board, attacker, plies - 1, tuning, budget);
		} finally {
			board.undo();
		}
		if (result === null) return null;
		if (attacking && result) return true;
		if (!attacking && !result) return false;
	}
	return !attacking;
}

/**
 * Every piece `candidate` leaves to be taken for a concession — not only the piece that moved.
 * `piecesOnly` is the played move's test (`BRILLIANT.pawnLossNotSacrifice`); an alternative is
 * scanned without it, because "gives up less" and "gives nothing away" count a pawn too.
 */
function scanOffers(
	fen: string,
	candidate: string,
	tuning: BrilliantTuning,
	piecesOnly = false
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
		const budget = { nodes: 0 };
		const value = exchangeGain(board, reply, tuning, budget);
		if (value === null) {
			complete = false;
			continue;
		}
		const concession = value - gain(moved);
		if (concession < tuning.minConcession) continue;
		// A piece traded evenly whose recapturing pawn then falls gave up a pawn, not a piece.
		if (piecesOnly && tuning.pawnLossNotSacrifice > 0) {
			const pieces = exchangeGain(board, reply, tuning, { nodes: 0 }, 0, moved.color);
			if (pieces === null) {
				complete = false;
				continue;
			}
			if (pieces - gain(moved) < tuning.minConcession) continue;
		}
		const indirect = reply.to !== moved.to;
		let checkRecovered = false;
		if (indirect) {
			const recovered = hasOffSquareRecovery(board, reply, tuning, budget);
			if (recovered === null) complete = false;
			if (recovered === true) continue;
			// Won back only with check: whether that unmakes the gift depends on the mover's rating.
			if (recovered === false && piecesOnly && tuning.checkRecoveryMinRating > 0) {
				const byCheck = hasOffSquareRecovery(board, reply, tuning, budget, undefined, true);
				if (byCheck === null) complete = false;
				checkRecovered = byCheck === true;
			}
		}
		// The moved piece stays an offer — whether its standing threat unmakes the gift depends on
		// the mover's rating, which only `evaluateBrilliant` knows.
		let standing = false;
		if (!indirect && piecesOnly && tuning.standingThreatMinRating > 0) {
			const threat = hasOffSquareRecovery(board, reply, tuning, { nodes: 0 }, passed(board));
			if (threat === null) complete = false;
			standing = threat === true;
		}
		const shape: SacrificeShape = indirect
			? before.isAttacked(reply.to, reply.color)
				? "ignored-threat"
				: "indirect"
			: moved.piece === "r" && (reply.piece === "b" || reply.piece === "n")
				? "exchange-sacrifice"
				: moved.captured
					? "capture-sacrifice"
					: "hanging-piece";
		offers.push({
			capture: uciOf(reply),
			square: reply.to,
			shape,
			concession,
			...(standing ? { standing } : {}),
			...(checkRecovered ? { checkRecovered } : {}),
		});
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
	const scan = scanOffers(input.fen, input.uci, tuning, true);
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

/**
 * A moved piece the engine's line takes, and the mover's very next move leaves it at least
 * `netRegainNotSacrifice` pawns ahead of where it stood before the move: material won by force.
 */
function wonAtOnce(
	plan: BrilliantPlan,
	pv: readonly string[],
	rating: number | undefined,
	tuning: BrilliantTuning
): boolean {
	const [move, reply, answer] = pv;
	if (tuning.netRegainNotSacrifice <= 0 || effectiveRating(rating) < tuning.netRegainMinRating)
		return false;
	if (move !== plan.uci || !reply || !answer) return false;
	if (!plan.offers.some((offer) => offer.capture === reply && offersMovedPiece(offer))) return false;
	const board = loadPosition(plan.fen);
	if (!board) return false;
	const color = board.turn();
	const before = balance(board, color);
	if (!playUci(board, move) || !playUci(board, reply) || !playUci(board, answer)) return false;
	return balance(board, color) >= before + tuning.netRegainNotSacrifice;
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
	const rating = effectiveRating(evidence.moverRating);
	const unmade = (offer: SacrificeOffer): boolean =>
		(offer.standing === true &&
			tuning.standingThreatMinRating > 0 &&
			rating >= tuning.standingThreatMinRating) ||
		(offer.checkRecovered === true &&
			tuning.checkRecoveryMinRating > 0 &&
			rating >= tuning.checkRecoveryMinRating);
	if (plan.offers.every(unmade)) return verdict("illusion");
	if (
		evidence.playedPv &&
		(regainedAtOnce(plan, evidence.playedPv, tuning) ||
			wonAtOnce(plan, evidence.playedPv, evidence.moverRating, tuning))
	)
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
	const fasterMateElsewhere = evidence.alternatives.some(
		(alt) => (alt.mate ?? 0) > 0 && (alt.mate ?? 0) < (evidence.playedMate ?? 0)
	);
	if (
		nearBestLoss > byRating(tuning.maxLossNovice, tuning.maxLossExpert, evidence.moverRating) ||
		(mateElsewhere && (evidence.playedMate ?? 0) <= 0) ||
		(tuning.slowerMateNotBrilliant > 0 && fasterMateElsewhere)
	)
		return verdict("not-near-best");
	// 4. Fight, or victory lap?
	const bestAlternative = Math.max(0, ...evidence.alternatives.map((alt) => alt.points));
	// A victory lap means the win was there without giving anything away, so only a plain
	// alternative answers gate 4: a move that sacrifices as well is the same idea with another
	// piece (`sacrificialAlternativeNotTrivial`). `bestAlternative` above keeps every alternative —
	// the continuation test below asks a different question.
	const plain =
		tuning.sacrificialAlternativeNotTrivial > 0
			? evidence.alternatives.filter((alt) => {
					const scan = scanOffers(plan.fen, alt.uci, tuning);
					// An unproved exchange must not erase evidence of an already available win.
					return !scan.complete || scan.offers.length === 0;
				})
			: evidence.alternatives;
	const plainBest = Math.max(0, ...plain.map((alt) => alt.points));
	const ratedPlainBest = Math.max(0, ...plain.map((alt) => alt.ratedPoints ?? 0));
	// A quiet mating threat in an already won position need not be a sacrifice. Require a
	// winning non-sacrificing alternative AND prove that every already-attacked piece is
	// tactically untakeable. New/indirect offers, checks, and genuine moved-piece sacrifices
	// remain eligible, even when accepting them leads to mate.
	if (
		plainBest >= tuning.matingThreatAlternative &&
		(evidence.playedMate ?? 0) <= 0 &&
		tuning.ignoredThreatMatePlies > 0 &&
		plan.offers.every((offer) => offer.shape === "ignored-threat") &&
		board
	) {
		const move = playUci(board, plan.uci);
		if (move && !move.captured && !move.promotion && !/[+#]/.test(move.san)) {
			const budget = { nodes: 0 };
			const protectedByMate = plan.offers.every((offer) => {
				if (!playUci(board, offer.capture)) return false;
				try {
					return checkingMate(board, move.color, tuning.ignoredThreatMatePlies, tuning, budget) === true;
				} finally {
					board.undo();
				}
			});
			if (protectedByMate) return verdict("mating-threat");
		}
	}
	// The fastest mate is still the move that had to be found, however winning the rest is.
	const playedMate = evidence.playedMate ?? 0;
	const alternativeMates = evidence.alternatives.flatMap((alt) =>
		alt.mate !== undefined && alt.mate > 0 ? [alt.mate] : []
	);
	const fastestMate = playedMate > 0 && alternativeMates.every((mate) => mate >= playedMate);
	const fasterMate = playedMate > 0 && alternativeMates.every((mate) => mate > playedMate);
	// Already winning, and the sacrifice gains nothing on the plain move: a gratuitous one.
	// The rated test reads "already won" at the mover's rating — +7 is ≈ 0.93 on the reference
	// curve but ≈ 0.98 at 2655 (the owner's 32…Nxb2, 2026-09-23, 184267516150) — and the gain on
	// the reference curve, where it is not compressed. A sacrifice worse than the plain move is
	// the near-best gate's question, not a victory lap (the benchmark's 21.Bf6, 2323).
	const gain = evidence.playedPoints - plainBest;
	const gratuitous =
		((plainBest >= tuning.gratuitousWinning && gain < tuning.gratuitousGain) ||
			(tuning.gratuitousRatedWinning > 0 &&
				ratedPlainBest >= tuning.gratuitousRatedWinning &&
				gain >= 0 &&
				gain < tuning.gratuitousGain)) &&
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
