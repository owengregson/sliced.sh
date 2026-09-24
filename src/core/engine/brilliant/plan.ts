/** The engine-free half: the offers a move makes and whether a safer move existed. */

import { loadPosition } from "@core/chess/fen";
import { BRILLIANT } from "@core/constants/review";
import { uciOf } from "./material";
import { scanOffers } from "./offers";
import type { BrilliantPlan, BrilliantPlanInput, BrilliantTuning, SacrificeOffer } from "./types";

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
