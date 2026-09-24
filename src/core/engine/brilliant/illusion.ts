/** Offers the engine's own line shows to be no gift: the material comes straight back. */

import { loadPosition } from "@core/chess/fen";
import { playUci } from "@core/chess/san";
import { effectiveRating } from "../expected-points";
import { balance } from "./material";
import { offersMovedPiece } from "./offers";
import type { BrilliantPlan, BrilliantTuning } from "./types";

/**
 * An ignored threat that is no gift: along the engine's own line the opponent takes the threatened
 * piece and the mover's very next move wins the material straight back (within
 * `illusionRegainTolerance`), on another square the exchange search does not look at. Only
 * ignored threats — a sacrifice by capture that regains material at once is still a sacrifice.
 */
export function regainedAtOnce(
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
export function wonAtOnce(
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
