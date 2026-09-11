/**
 * Premove candidates (Task 15, §7.4, Appendix E §3.1). After our move `m`,
 * predict the opponent's reply `r` (the engine's `ponder` or a short MultiPV-3
 * search), normally require `p(r) ≥ 0.6` under softmax(τ = 0.06), then analyse
 * `m r` and premove our reply `q` only when it is
 * forced-looking: a recapture on the just-captured square, the only legal move
 * or a clear-only move (`loss_2nd ≥ 0.25`). A timed lone-king escape is allowed
 * only when every legal opponent reply preserves its legality. The engine
 * searches are injected (`analyseAfter`). Safe queued trades have a separate, higher attempt
 * propensity, but require the same prediction confidence and a plausible material exchange.
 */

import { loadPosition } from "@core/chess/fen";
import type { PositionHistory } from "@core/chess/history";
import { isLoneKing, material, PIECE_VALUES } from "@core/chess/material";
import { classifyMove } from "@core/chess/move-classify";
import { phase } from "@core/chess/phase";
import { applyMoves, legalMoves, parseUci } from "@core/chess/san";
import { PREMOVE } from "@core/constants/books";
import type { Rng } from "@core/rng";
import { tcClass } from "@core/timing/features";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import type { TcClass } from "@core/timing/types";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import type { Square, TimeControl } from "@typedefs/game";
import { conversionPool } from "./conversion";
import { cpEffective, winProb } from "./elo-map";
import { avoidRepetition } from "./repetition";

export interface PremoveContext {
	/** Position before our move. */
	fen: string;
	/** Our chosen move `m` (UCI). */
	move: string;
	/** Effective Elo `E`. */
	targetElo: number;
	timeControl?: TimeControl | undefined;
	/** The engine's `ponder` move after `m`, when it reported one. */
	ponder?: string | undefined;
	rng: Rng;
	/** Timing-model premove propensity π_p in [0, 1] (default 1). */
	piP?: number | undefined;
	/** Validated game history through our move, for the projected reply search. */
	historyAfterMove?: PositionHistory;
	ownClockMs?: number;
	opponentClockMs?: number;
}

export interface AnalyseOptions {
	movetimeMs: number;
	multiPv: number;
}

export interface PremoveDeps {
	/** MultiPV lines (side-to-move POV) after playing `moves` from `fen`. */
	analyseAfter(fen: string, moves: readonly string[], opts: AnalyseOptions): Promise<EvalLine[]>;
}

export type PremoveReason = "recapture" | "only-move" | "loss2nd" | "king-escape";

export interface PremoveCandidate {
	/** The opponent reply `r` the premove is conditioned on. */
	reply: string;
	/** Our premove `q`. */
	premove: string;
	from: Square;
	to: Square;
	promotion?: "q" | "r" | "b" | "n";
	reason: PremoveReason;
	replyProbability: number;
}

/** `0.35 + 0.5·clamp((E − 1200)/1200, 0, 1)` × π_p; 0 below E = 1200. */
export function premoveProbability(E: number, piP = 1): number {
	if (E < PREMOVE.minElo) return 0;
	const base =
		PREMOVE.probBase + PREMOVE.probRange * clamp((E - PREMOVE.minElo) / PREMOVE.probSpan, 0, 1);
	return clamp(base * clamp(piP, 0, 1), 0, 1);
}

export function tradePremoveProbability(E: number, piP = 1): number {
	if (piP <= 0) return 0;
	const base =
		PREMOVE.tradeProbBase +
		PREMOVE.tradeProbRange * clamp((E - PREMOVE.minElo) / PREMOVE.probSpan, 0, 1);
	return base * (PREMOVE.tradePersonaFloor + (1 - PREMOVE.tradePersonaFloor) * clamp(piP, 0, 1));
}

/**
 * A reason alone is not proof that a queued move is safe. Require a recapture onto our own
 * occupied square; every other reply that leaves it legal must also be a safe exchange there.
 */
export function isQueueableCandidate(
	afterMove: string,
	candidate: Pick<PremoveCandidate, "reply" | "premove" | "reason">
): boolean {
	if (!isQueueableReason(candidate.reason)) return false;
	if (candidate.reason === "king-escape")
		return isUniversalKingPremove(afterMove, candidate.premove);
	const board = loadPosition(afterMove);
	const parts = parseUci(candidate.premove);
	if (!board || !parts) return false;
	const target = board.get(parts.to);
	const ours = board.get(parts.from);
	if (!target || !ours || target.color !== ours.color || target.color === board.turn()) return false;
	const predicted = applyMoves(afterMove, [candidate.reply]);
	if (
		!predicted ||
		!classifyMove(afterMove, candidate.reply)?.isCapture ||
		!classifyMove(predicted, candidate.premove, candidate.reply)?.isRecapture
	)
		return false;
	for (const reply of legalMoves(afterMove)) {
		const next = applyMoves(afterMove, [reply]);
		if (!next) continue;
		const recapture = classifyMove(next, candidate.premove, reply);
		if (!recapture) continue; // The site drops an illegal premove.
		const capture = classifyMove(afterMove, reply);
		if (!capture?.isCapture || !recapture.isRecapture) return false;
		const afterRecapture = applyMoves(next, [candidate.premove]);
		if (!afterRecapture) return false;
		// A recapture which allows mate in one is not a safe trade, even on the predicted branch.
		const responses = legalMoves(afterRecapture);
		if (responses.some((response) => classifyMove(afterRecapture, response)?.givesMate)) return false;
		if (recapture.capturedType && PIECE_VALUES[recapture.capturedType] < PIECE_VALUES[ours.type]) {
			// A queen taking back a pawn is safe only when no legal reply can take the queen.
			for (const response of responses) {
				if (parseUci(response)?.to === parts.to && classifyMove(afterRecapture, response)?.isCapture)
					return false;
			}
		}
	}
	return true;
}

/** A lone king may queue an escape only when every legal opponent reply leaves it legal. */
export function isUniversalKingPremove(afterMove: string, premove: string): boolean {
	const board = loadPosition(afterMove);
	const parts = parseUci(premove);
	if (!board || !parts || parts.promotion) return false;
	const us = board.turn() === "w" ? "b" : "w";
	if (
		!isLoneKing(afterMove, us) ||
		board.get(parts.from)?.color !== us ||
		board.get(parts.from)?.type !== "k"
	)
		return false;
	const replies = legalMoves(afterMove);
	return (
		replies.length > 0 &&
		replies.every((reply) => {
			const next = applyMoves(afterMove, [reply]);
			return next !== null && classifyMove(next, premove)?.pieceType === "k";
		})
	);
}

function loneKingCandidate(afterMove: string): PremoveCandidate | null {
	const reply = legalMoves(afterMove)[0];
	const next = reply ? applyMoves(afterMove, [reply]) : null;
	if (!reply || !next) return null;
	for (const premove of legalMoves(next)) {
		if (!isUniversalKingPremove(afterMove, premove)) continue;
		const parts = parseUci(premove);
		if (parts)
			return {
				reply,
				premove,
				from: parts.from,
				to: parts.to,
				reason: "king-escape",
				replyProbability: 0,
			};
	}
	return null;
}

/** Cheap eligibility before interrupting continuous pondering in a slower time control. */
export function hasTradeOffer(afterMove: string): boolean {
	const board = loadPosition(afterMove);
	if (!board) return false;
	for (const reply of board.moves({ verbose: true })) {
		if (!reply.isCapture()) continue;
		const next = loadPosition(reply.after);
		if (
			next
				?.moves({ verbose: true })
				.some((move) => move.to === reply.to && move.isCapture() && move.piece !== "k")
		)
			return true;
	}
	return false;
}

/** Softmax(τ = 0.06) over the opponent lines' win fractions; 0 when `reply` is not among them. */
export function replyProbability(reply: string, lines: readonly EvalLine[]): number {
	if (lines.length === 0) return 0;
	const wins = lines.map((line) => winProb(cpEffective(line.score)));
	const max = Math.max(...wins);
	let total = 0;
	let own = 0;
	for (let i = 0; i < lines.length; i++) {
		const w = Math.exp(((wins[i] ?? 0) - max) / PREMOVE.replyTau);
		total += w;
		if (lines[i]?.pvUci[0] === reply) own += w;
	}
	return total > 0 ? own / total : 0;
}

/** Only fresh, distinct, comparable root scores are evidence about the next opponent move. */
function predictionLines(lines: readonly EvalLine[], legalReplies: readonly string[]): EvalLine[] {
	const roots = new Set<string>();
	return [...lines]
		.sort((a, b) => a.multipv - b.multipv)
		.filter((line) => {
			const reply = line.pvUci[0];
			if (
				!reply ||
				!legalReplies.includes(reply) ||
				roots.has(reply) ||
				line.bound !== undefined ||
				!Number.isFinite(line.depth) ||
				line.depth < PREMOVE.replyMinDepth ||
				!(Number.isFinite(line.score.cp) || Number.isFinite(line.score.mate))
			)
				return false;
			roots.add(reply);
			return true;
		});
}

function plausibleScore(candidate: EvalLine, best: EvalLine): boolean {
	if (best.score.mate !== undefined) {
		if (candidate.score.mate === undefined) return best.score.mate < 0;
		if (best.score.mate > 0)
			return candidate.score.mate > 0 && candidate.score.mate <= best.score.mate;
		return candidate.score.mate < 0 && candidate.score.mate <= best.score.mate;
	}
	if (candidate.score.mate !== undefined) return candidate.score.mate > 0;
	return (best.score.cp ?? 0) - (candidate.score.cp ?? 0) <= PREMOVE.replyMaxCpLoss;
}

/**
 * Legality does not make a queen donation believable. Check the material exchange from the
 * opponent's side, giving them credit for their best immediate legal takeback on this square.
 * This deliberately leaves compensated sacrifices to normal play after the move appears.
 */
function plausibleExchange(afterMove: string, reply: string, premove: string): boolean {
	const before = material(afterMove);
	const next = applyMoves(afterMove, [reply, premove]);
	const board = next && loadPosition(next);
	const square = parseUci(premove)?.to;
	if (!before || !board || !square) return false;
	const after = material(board.fen());
	if (!after) return false;
	const direction = board.turn() === "w" ? 1 : -1;
	let gain = direction * (after.diff - before.diff);
	for (const takeback of board.moves({ verbose: true })) {
		if (takeback.to !== square || !takeback.isCapture()) continue;
		const final = material(takeback.after);
		if (final) gain = Math.max(gain, direction * (final.diff - before.diff));
	}
	return gain >= -PREMOVE.tradeMaxMaterialLoss;
}

/**
 * Category eligibility for a site queue. isQueueableCandidate provides the actual board proof;
 * a reason cannot establish that an unexpected reply makes a move illegal.
 */
export function isQueueableReason(reason: PremoveReason): boolean {
	return (PREMOVE.queueReasons as readonly PremoveReason[]).includes(reason);
}

/** Ordinary premoves use these speed classes; safe trades and clock races also work in slower controls. */
export function isPremoveSpeed(timeControl: TimeControl | undefined): boolean {
	if (!timeControl) return false;
	const cls = tcClass(timeControl.baseMs / 1000, timeControl.incMs / 1000);
	return (PREMOVE.speeds as readonly TcClass[]).includes(cls);
}

/**
 * The premove to arm after `ctx.move`, or `null` when the situation is not
 * forced enough (or the gates say no). Cheap gates run before any engine time is spent.
 */
export async function premoveCandidate(
	ctx: PremoveContext,
	deps: PremoveDeps
): Promise<PremoveCandidate | null> {
	const afterMove = applyMoves(ctx.fen, [ctx.move]);
	if (afterMove === null) return null;
	const us = loadPosition(ctx.fen)?.turn();
	const race = clockRacePolicy({
		ownClockMs: ctx.ownClockMs ?? 0,
		opponentClockMs: ctx.opponentClockMs ?? 0,
		baseMs: ctx.timeControl?.baseMs ?? 0,
		incrementMs: ctx.timeControl?.incMs ?? 0,
		loneKing: us !== undefined && isLoneKing(ctx.fen, us),
	});
	if (race && us !== undefined && isLoneKing(afterMove, us) && ctx.piP !== 0) {
		const kingEscape = loneKingCandidate(afterMove);
		if (kingEscape) return kingEscape;
	}
	const ordinaryAllowed = isPremoveSpeed(ctx.timeControl) || race !== null;
	if (!ordinaryAllowed && !(ctx.timeControl && ctx.timeControl.baseMs > 0)) return null;
	if (!ordinaryAllowed && !hasTradeOffer(afterMove)) return null;
	const ordinaryP = premoveProbability(ctx.targetElo, ctx.piP);
	const p = Math.max(ordinaryP, tradePremoveProbability(ctx.targetElo, ctx.piP));
	if (p <= 0 || !ctx.rng.chance(p)) return null;
	const legalReplies = legalMoves(afterMove);
	if (ctx.ponder !== undefined && !legalReplies.includes(ctx.ponder)) return null;
	const analysedOpponent = await deps.analyseAfter(ctx.fen, [ctx.move], {
		movetimeMs: Math.min(PREMOVE.ponderMovetimeMs, race?.maxSearchMs ?? Number.POSITIVE_INFINITY),
		multiPv: PREMOVE.ponderMultiPv,
	});
	const opponentLines = predictionLines(analysedOpponent, legalReplies);
	if (opponentLines.length < Math.min(PREMOVE.replyMinAlternatives, legalReplies.length))
		return null;
	const bestPrediction = opponentLines[0];
	const primaryReply = bestPrediction?.pvUci[0];
	if (bestPrediction?.multipv !== 1 || !primaryReply) return null;
	for (const prediction of opponentLines) {
		const reply = prediction.pvUci[0];
		if (!reply || !plausibleScore(prediction, bestPrediction)) continue;
		const pReply = replyProbability(reply, opponentLines);
		if (pReply < PREMOVE.replyMinProb) continue;
		const replyCaptured = classifyMove(afterMove, reply)?.isCapture ?? false;
		const afterReply = applyMoves(afterMove, [reply]);
		if (afterReply === null) continue;
		const analysed = await deps.analyseAfter(ctx.fen, [ctx.move, reply], {
			movetimeMs: Math.min(PREMOVE.replyMovetimeMs, race?.maxSearchMs ?? Number.POSITIVE_INFINITY),
			multiPv: PREMOVE.replyMultiPv,
		});
		const projectedHistory = ctx.historyAfterMove && {
			fen: ctx.historyAfterMove.fen,
			moves: [...ctx.historyAfterMove.moves, reply],
		};
		const repetitionSafe = avoidRepetition(analysed, afterReply, projectedHistory).lines;
		const lines = conversionPool(repetitionSafe, {
			fen: afterReply,
			phase: phase(afterReply) ?? "middlegame",
			...(projectedHistory ? { history: projectedHistory } : {}),
		}).lines;
		const best = lines[0];
		const q = best?.pvUci[0];
		if (!best || !q) continue;
		const facts = classifyMove(afterReply, q, reply);
		if (!facts || facts.pieceType === "k" || facts.isCastle) continue;
		let reason: PremoveReason | null = null;
		if (facts.isRecapture && replyCaptured) reason = "recapture";
		else if (facts.isOnlyMove) reason = "only-move";
		else if (
			lines[1] &&
			winProb(cpEffective(best.score)) - winProb(cpEffective(lines[1].score)) >= PREMOVE.loss2ndMin
		)
			reason = "loss2nd";
		if (!reason) continue;
		if (reason === "recapture" && legalReplies.length > 1 && !plausibleExchange(afterMove, reply, q))
			continue;
		const parts = parseUci(q);
		if (!parts) continue;
		const candidate: PremoveCandidate = {
			reply,
			premove: q,
			from: parts.from,
			to: parts.to,
			reason,
			replyProbability: pReply,
		};
		if (parts.promotion !== undefined) candidate.promotion = parts.promotion;
		const safeTrade = reason === "recapture" && isQueueableCandidate(afterMove, candidate);
		if (
			!safeTrade &&
			(!ordinaryAllowed ||
				ordinaryP <= 0 ||
				reply !== primaryReply ||
				pReply < PREMOVE.replyMinProb ||
				!ctx.rng.chance(ordinaryP / p))
		)
			continue;
		return candidate;
	}
	return null;
}
