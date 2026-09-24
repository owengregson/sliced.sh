/**
 * The fast-reply rule (2026-09-24, `docs/qa/timing-calibration-2026-09-24.md`): a position whose
 * answer is already decided without the full search — the book answers with the move the selector
 * will play, or the analysis made during the opponent's turn already rated an obvious recapture
 * best — ends its own-move search at
 * `SEARCH_BUDGET.fastReplyMs` for the class. The search deadline is the earliest the hand can
 * start, so without the cap a book move or a recapture could not be released under ≈ 1 s in blitz
 * (600 ms search + the hand), while chess.com's 2200+ players make most of them faster. The think
 * the timing model samples is unchanged; the cap only stops the search from outlasting it.
 * Max-strength mode keeps its full search (owner, 2026-09-15), and a position the tablebase
 * answers is left alone (the caller skips the rule).
 */

import { BOOK } from "@core/constants/books";
import { SEARCH_BUDGET } from "@core/constants/search";
import { isMaxStrength } from "@core/strength/max-strength";
import { isObviousRecapture } from "@core/timing/calibration";
import { tcClass } from "@core/timing/features";
import type { ChosenMove } from "@typedefs/game";

import { type SearchBudget, tcSeconds } from "./budget";
import { maiaPlaysOpening } from "./maia-search";
import type { RecommendationInput } from "./types";

async function bookAnswered(pending: Promise<ChosenMove | null>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), SEARCH_BUDGET.fastReplyBookWaitMs);
	});
	try {
		return (await Promise.race([pending.catch(() => null), timeout])) !== null;
	} finally {
		clearTimeout(timer);
	}
}

/** Whether this position is a fast reply (see the file comment). */
export async function isFastReply(
	input: RecommendationInput,
	bookPending: Promise<ChosenMove | null>
): Promise<boolean> {
	if (isMaxStrength(input.targetElo)) return false;
	const { snapshot } = input;
	const last = input.moves.length ? input.moves[input.moves.length - 1] : undefined;
	// A recapture only when the analysis of the opponent's turn already rated it best: the search
	// it cuts short would only have confirmed it, so the move played is the same.
	const answer = input.ponderedAnswer;
	if (answer && isObviousRecapture(input.priorFen, last, snapshot.fen, answer)) return true;
	if (
		snapshot.ply > BOOK.maxPly ||
		maiaPlaysOpening({ targetElo: input.targetElo, form: input.form })
	)
		return false;
	return bookAnswered(bookPending);
}

/** `budget` with its movetime capped for a fast reply (MultiPV and depth unchanged: cache identity). */
export function fastReplyBudget(budget: SearchBudget, input: RecommendationInput): SearchBudget {
	const [baseSec, incSec] = tcSeconds(input.snapshot.timeControl);
	const cap = SEARCH_BUDGET.fastReplyMs[tcClass(baseSec, incSec)];
	return budget.movetimeMs <= cap ? budget : { ...budget, movetimeMs: cap };
}
