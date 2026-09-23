/** The opening book's part: its answer for the position, and whether Maia plays the opening. */

import { MAIA } from "@core/constants/maia";
import { log } from "@core/logger";
import type { PolicyResult } from "@core/policy/types";
import type { BookContext, BookPolicy } from "@core/strength/book/book-policy";
import { effectiveElo } from "@core/strength/elo-map";
import { isMaxStrength } from "@core/strength/max-strength";
import { errorMessage } from "@core/util/errors";
import type { ChosenMove } from "@typedefs/game";

import { maiaPlaysOpening } from "./maia-search";
import type { RecommendationInput } from "./types";

/**
 * Opening-book answer, or null when disabled, unavailable or failed. The book is off above the
 * Maia cutoff (`MAIA.eloMax`, the one strength division since 2026-09-15). Max-strength mode
 * never consults the book on its own account (owner, 2026-09-15: "the absolute best possible
 * move"), whatever that cutoff is later set to.
 */
export async function bookMove(
	policy: BookPolicy | null,
	input: RecommendationInput
): Promise<ChosenMove | null> {
	if (
		!policy ||
		!input.settings.strength.useOpeningBook ||
		input.targetElo > MAIA.eloMax ||
		isMaxStrength(input.targetElo)
	)
		return null;
	const ctx: BookContext = {
		fen: input.snapshot.fen,
		ply: input.snapshot.ply,
		targetElo: effectiveElo(input.targetElo, input.form),
		useOpeningBook: true,
		rng: input.rng,
	};
	try {
		return await policy.bookMove(ctx);
	} catch (error) {
		log.warn("recommendation: book failed", { error: errorMessage(error) });
		return null;
	}
}

/** Who plays the opening: the book answer the selector may use, and whether Maia took over. */
export interface OpeningChoice {
	book: ChosenMove | null;
	maiaOpening: boolean;
}

/** Use Maia for eligible opening choices only when its answer arrived; retain the book fallback. */
export function openingChoice(
	input: RecommendationInput,
	maia: boolean,
	policyResult: PolicyResult | null,
	bookAnswer: ChosenMove | null
): OpeningChoice {
	const maiaOpening =
		policyResult !== null &&
		maia &&
		maiaPlaysOpening({ targetElo: input.targetElo, form: input.form });
	const book = maiaOpening ? null : bookAnswer;
	if (maiaOpening && bookAnswer)
		log.debug("recommendation: book suppressed, maia plays the opening", {
			uci: bookAnswer.uci,
			ply: input.snapshot.ply,
		});
	return { book, maiaOpening };
}
