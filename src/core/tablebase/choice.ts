/** A ranked tablebase answer as the pipeline's `ChosenMove`. */

import { legalMoves, parseUci, uciToSan } from "@core/chess/san";
import { moveQuality } from "@core/strength/quality";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";
import type { TablebaseAnswer } from "./rank";

function describe(answer: TablebaseAnswer): string {
	const { best } = answer;
	if (best.checkmate) return "checkmate";
	const zeroing =
		best.zeroingPlies === null ? "" : `, next zeroing move in ${best.zeroingPlies} plies`;
	const mate = best.mateInPlies === null ? "" : `, mate in ${best.mateInPlies} plies after it`;
	return `${best.outcome}${zeroing}${mate}`;
}

/**
 * The best move of `answer` in `fen` as a `tablebase` choice, or `null` if it is not legal on the
 * board (never played). `lines` are the engine's lines for the position (rank and loss only).
 */
export function tablebaseChosenMove(
	fen: string,
	answer: TablebaseAnswer,
	lines: readonly EvalLine[],
	rationale: readonly string[]
): ChosenMove | null {
	const uci = answer.best.uci;
	const parts = parseUci(uci);
	if (!parts || !legalMoves(fen).includes(uci)) return null;
	const line = lines.find((l) => l.pvUci[0] === uci);
	const measured = moveQuality(lines, line);
	const chosen: ChosenMove = {
		uci,
		san: uciToSan(fen, uci) ?? uci,
		from: parts.from,
		to: parts.to,
		source: "tablebase",
		rankInLines: line === undefined ? 0 : lines.indexOf(line) + 1,
		quality: { ...measured.quality, kind: "book", eligible: false, reason: "tablebase" },
		rationale: [...rationale, `tablebase: ${describe(answer)}`],
	};
	if (measured.cpLoss !== undefined) chosen.cpLoss = measured.cpLoss;
	if (parts.promotion !== undefined) chosen.promotion = parts.promotion;
	return chosen;
}
