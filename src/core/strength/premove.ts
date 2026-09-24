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
 *
 * H8 (2026-09-13): Maia is the premove **gate**, never the chooser. When the caller already holds
 * the human policy's answer for the predicted position `m r` (`PremoveContext.policy`, the H7.3
 * pre-inference), a candidate `q` is armed only if `p_maia(q | m r) ≥ PREMOVE.maiaMinProb`
 * (`maiaPremoveGate`) — a human premoves a move they would have played anyway. The session
 * applies the same gate after the fact when the answer arrives later than the arm.
 */

import { loadPosition } from "@core/chess/fen";
import { isLoneKing } from "@core/chess/material";
import { classifyMove, type MoveClassification } from "@core/chess/move-classify";
import { phase } from "@core/chess/phase";
import { applyMoves, legalMoves, parseUci } from "@core/chess/san";
import { PREMOVE } from "@core/constants/books";
import { type ClockRacePolicy, clockRacePolicy } from "@core/timing/opponent-pressure";
import type { EvalLine } from "@typedefs/engine";
import { conversionPool } from "./conversion";
import { cpEffective, winProb } from "./elo-map";
import { isMaxStrength } from "./max-strength";
import { maiaPremoveGate } from "./premove/gate";
import { plausibleScore, predictionLines, replyProbability } from "./premove/prediction";
import { isPremoveSpeed, premoveProbability, tradePremoveProbability } from "./premove/propensity";
import {
	hasTradeOffer,
	isQueueableCandidate,
	loneKingCandidate,
	plausibleExchange,
} from "./premove/queue-safety";
import type { PremoveCandidate, PremoveContext, PremoveDeps, PremoveReason } from "./premove/types";
import { avoidRepetition } from "./repetition";

export { maiaPremoveGate } from "./premove/gate";
export { replyProbability } from "./premove/prediction";
export {
	isPremoveSpeed,
	isQueueableReason,
	premoveProbability,
	tradePremoveProbability,
} from "./premove/propensity";
export {
	hasTradeOffer,
	isQueueableCandidate,
	isUniversalKingPremove,
} from "./premove/queue-safety";
export type {
	AnalyseOptions,
	PredictedPolicy,
	PremoveCandidate,
	PremoveContext,
	PremoveDeps,
	PremoveReason,
} from "./premove/types";

/** What the cheap gates settled before the per-reply search. */
interface PremoveGates {
	afterMove: string;
	race: ClockRacePolicy | null;
	/** Ordinary (non-trade) premoves are allowed in this time control or race. */
	ordinaryAllowed: boolean;
	/** The ordinary attempt propensity, and the larger of it and the trade propensity. */
	ordinaryP: number;
	p: number;
	legalReplies: string[];
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
	const ordinaryP = ctx.propensity?.ordinary ?? premoveProbability(ctx.targetElo, ctx.piP);
	const tradeP = ctx.propensity?.trade ?? tradePremoveProbability(ctx.targetElo, ctx.piP);
	const p = Math.max(ordinaryP, tradeP);
	if (p <= 0 || !ctx.rng.chance(p)) return null;
	const legalReplies = legalMoves(afterMove);
	if (ctx.ponder !== undefined && !legalReplies.includes(ctx.ponder)) return null;
	const gates: PremoveGates = { afterMove, race, ordinaryAllowed, ordinaryP, p, legalReplies };
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
		// Under the think-time calibration a capture may arm a safe trade on a weaker prediction: a
		// queued trade is legal only if they take on that square (`isQueueableCandidate`), so it
		// cannot fire on any other reply. Every other candidate still needs `replyMinProb`
		// (`premoveAfterReply`).
		const tradeMin = ctx.propensity?.tradeReplyMinProb;
		const minProb =
			tradeMin !== undefined && classifyMove(afterMove, reply)?.isCapture === true
				? tradeMin
				: PREMOVE.replyMinProb;
		if (pReply < minProb) continue;
		const candidate = await premoveAfterReply(ctx, deps, gates, reply, pReply, primaryReply);
		if (candidate) return candidate;
	}
	return null;
}

/**
 * Why our reply `q` to `reply` looks forced: a recapture of what `reply` took, the only legal
 * move, or clearly the best (`loss_2nd`); `null` when it does not.
 */
function premoveReason(
	facts: MoveClassification,
	replyCaptured: boolean,
	lines: readonly EvalLine[]
): PremoveReason | null {
	const best = lines[0];
	if (facts.isRecapture && replyCaptured) return "recapture";
	if (facts.isOnlyMove) return "only-move";
	if (
		best &&
		lines[1] &&
		winProb(cpEffective(best.score)) - winProb(cpEffective(lines[1].score)) >= PREMOVE.loss2ndMin
	)
		return "loss2nd";
	return null;
}

/**
 * Search our answer to one predicted `reply` and arm it when it is forced-looking and every gate
 * agrees; `null` moves on to the next prediction.
 */
async function premoveAfterReply(
	ctx: PremoveContext,
	deps: PremoveDeps,
	gates: PremoveGates,
	reply: string,
	pReply: number,
	primaryReply: string
): Promise<PremoveCandidate | null> {
	const { afterMove, race, ordinaryAllowed, ordinaryP, p, legalReplies } = gates;
	const replyCaptured = classifyMove(afterMove, reply)?.isCapture ?? false;
	const afterReply = applyMoves(afterMove, [reply]);
	if (afterReply === null) return null;
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
	if (!best || !q) return null;
	const facts = classifyMove(afterReply, q, reply);
	if (!facts || facts.pieceType === "k" || facts.isCastle) return null;
	const reason = premoveReason(facts, replyCaptured, lines);
	if (!reason) return null;
	if (reason === "recapture" && legalReplies.length > 1 && !plausibleExchange(afterMove, reply, q))
		return null;
	// H8: a human premoves a move they would have played anyway — the model's word, when it has
	// already answered for this very position.
	if (!maiaPremoveGate(afterReply, q, ctx.policy)) return null;
	const parts = parseUci(q);
	if (!parts) return null;
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
	// Max-strength mode (owner, 2026-09-15: "the absolute best possible move in every situation"):
	// a premove skips the deep own-move search, so it is armed only when the board itself proves
	// the move — the only legal move, or a recapture every legal reply leaves a safe exchange —
	// never a clear-best quiet move read off a 120 ms search (`loss2nd`).
	if (isMaxStrength(ctx.targetElo) && !safeTrade && reason !== "only-move") return null;
	if (
		!safeTrade &&
		(!ordinaryAllowed ||
			ordinaryP <= 0 ||
			reply !== primaryReply ||
			pReply < PREMOVE.replyMinProb ||
			!ctx.rng.chance(ordinaryP / p))
	)
		return null;
	return candidate;
}
