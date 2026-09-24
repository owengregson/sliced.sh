/**
 * Board proofs that a queued move is safe whatever the opponent replies: safe recapture trades,
 * lone-king escapes, and the material check that makes a predicted exchange believable.
 */

import { loadPosition } from "@core/chess/fen";
import { isLoneKing, material, PIECE_VALUES } from "@core/chess/material";
import { classifyMove } from "@core/chess/move-classify";
import { applyMoves, legalMoves, parseUci } from "@core/chess/san";
import { PREMOVE } from "@core/constants/books";
import { isQueueableReason } from "./propensity";
import type { PremoveCandidate } from "./types";

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

export function loneKingCandidate(afterMove: string): PremoveCandidate | null {
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

/**
 * Legality does not make a queen donation believable. Check the material exchange from the
 * opponent's side, giving them credit for their best immediate legal takeback on this square.
 * This deliberately leaves compensated sacrifices to normal play after the move appears.
 */
export function plausibleExchange(afterMove: string, reply: string, premove: string): boolean {
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
