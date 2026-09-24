/** Sacrifice detection: every piece a move leaves to be taken, and the shape of each offer. */

import { loadPosition } from "@core/chess/fen";
import { PIECE_VALUES } from "@core/chess/material";
import { playUci } from "@core/chess/san";
import { exchangeGain, gain, uciOf } from "./material";
import { hasOffSquareRecovery, passed } from "./recovery";
import type { BrilliantTuning, SacrificeOffer, SacrificeShape } from "./types";

/**
 * Every piece `candidate` leaves to be taken for a concession — not only the piece that moved.
 * `piecesOnly` is the played move's test (`BRILLIANT.pawnLossNotSacrifice`); an alternative is
 * scanned without it, because "gives up less" and "gives nothing away" count a pawn too.
 */
export function scanOffers(
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

/** The offer is the piece that moved: hung on its new square, capturing, or given for the exchange. */
export function offersMovedPiece(offer: SacrificeOffer): boolean {
	return offer.shape !== "ignored-threat" && offer.shape !== "indirect";
}
