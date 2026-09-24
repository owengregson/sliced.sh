/**
 * What the opponent's turn left behind for our answer to the reply that just arrived: the move
 * the analysis made on their clock rated best (`ponderedAnswer`, the fast-reply rule's and the
 * timing head's candidate), and where the idle hand rested (`hoverSquareOf`, the anticipatory
 * hover). Pure reads; the pipeline input carries both.
 */

import type { Square } from "@typedefs/game";
import type { PonderController } from "../ponder";
import type { MoveHistory } from "./move-history";
import type { PredictedAnalysis } from "./prediction";

/**
 * Our answer to the reply that just arrived, as the analysis made during the opponent's turn
 * rated it best: the pre-analysis of the predicted position when it predicted this reply, else
 * the ponder's top line when it starts with it. `null` when neither did.
 */
export function ponderedAnswer(
	history: Pick<MoveHistory, "moves" | "priorFen">,
	pre: PredictedAnalysis | null,
	ponderer: Pick<PonderController, "latestLines"> | null
): string | null {
	const moves = history.moves;
	const last = moves[moves.length - 1];
	if (last === undefined) return null;
	if (pre && pre.reply === last) return pre.lines[0]?.pvUci[0] ?? null;
	const prior = history.priorFen;
	const top = prior ? ponderer?.latestLines(prior)[0] : undefined;
	return top?.pvUci[0] === last ? (top.pvUci[1] ?? null) : null;
}

/**
 * Where the idle hand rested when the opponent's move arrived: `MoveExecutor.hoverSquare()` (the
 * anticipatory hover). Read structurally so an executor without the method answers `null`.
 */
export function hoverSquareOf(executor: unknown): Square | null {
	const read = (executor as { hoverSquare?: () => Square | null } | null)?.hoverSquare;
	return typeof read === "function" ? (read.call(executor) ?? null) : null;
}
