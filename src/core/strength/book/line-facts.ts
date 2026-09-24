/** A book move judged against the engine's lines: rank, loss and the §7.3 trap check. */

import { BOOK } from "@core/constants/books";
import type { EvalLine } from "@typedefs/engine";
import { cpEffective, winProb } from "../elo-map";
import { moveQuality, rankedLines } from "../quality";

export interface LineFacts {
	rank: number;
	cpLoss?: number;
	/** Win-fraction loss vs the best line; `null` when the move is not among the lines. */
	loss: number | null;
	/**
	 * Lower bound on the loss: exact when the move is in the lines, otherwise the loss of the
	 * worst reported line (a move outside MultiPV loses at least that much). 0 without lines.
	 */
	lossLowerBound: number;
}

/** Rank, cp loss and win-fraction loss of `uci` relative to the best of `lines`. */
export function lineFacts(uci: string, lines: readonly EvalLine[] | undefined): LineFacts {
	if (!lines || lines.length === 0) return { rank: 0, loss: null, lossLowerBound: 0 };
	let bestCp = Number.NEGATIVE_INFINITY;
	let worstCp = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		const cp = cpEffective(line.score);
		bestCp = Math.max(bestCp, cp);
		worstCp = Math.min(worstCp, cp);
	}
	const ranked = rankedLines(lines);
	const index = ranked.findIndex((line) => line.pvUci[0] === uci);
	if (index < 0) {
		const bound = Math.max(0, winProb(bestCp) - winProb(worstCp));
		return { rank: 0, loss: null, lossLowerBound: bound };
	}
	const cp = cpEffective(ranked[index]?.score ?? {});
	const loss = Math.max(0, winProb(bestCp) - winProb(cp));
	const measured = moveQuality(lines, ranked[index]);
	return {
		rank: index + 1,
		...(measured.cpLoss === undefined ? {} : { cpLoss: measured.cpLoss }),
		loss,
		lossLowerBound: loss,
	};
}

/**
 * §7.3: from E ≥ 1800 a book move losing ≥ 0.15 win-fraction vs the engine's best is a trap.
 * A move absent from the MultiPV lines is judged by its lower bound (it loses at least as much
 * as the worst reported line); it is only allowed when that bound stays below the threshold.
 */
export function isTrap(E: number, facts: LineFacts): boolean {
	return E >= BOOK.trapCheckElo && facts.lossLowerBound >= BOOK.trapLoss;
}
