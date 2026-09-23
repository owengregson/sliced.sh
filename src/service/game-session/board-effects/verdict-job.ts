/** One classification: a planned or landed move, and what still stands between it and a chip. */

import { loadPosition } from "@core/chess/fen";
import { applyMoves, legalMoves } from "@core/chess/san";
import { MOVE_CLASSIFICATION } from "@core/constants/review";
import { type MoveQualityVerdict, reviewLines } from "@core/engine/move-quality";

import type { FrameStore } from "./frame-store";
import { reviewKey } from "./keys";
import type { ClassifiedMove, DropReason } from "./types";

export interface VerdictJob {
	key: string;
	move: ClassifiedMove;
	mine: boolean;
	beforeKey: string;
	/** The position after the move, `null` when it is illegal. */
	after: { key: string; fen: string } | null;
	/** The position before the previous ply (Miss), when the history reaches back that far. */
	previousKey: string | null;
	/** Set once the move landed; effects have already been posted independently. */
	landed: { at: number } | null;
	/** The position had exactly one legal move: rated `forced` at once, no review needed. */
	forced: boolean;
	/**
	 * The move checkmates: rated `mate` at once — ahead of `forced`, so the final move of a mating
	 * sequence always carries its chip and its top-step sound.
	 */
	checkmate: boolean;
	/** Opening-book membership; `undefined` while the books are being read. */
	book: boolean | undefined;
	verdict: MoveQualityVerdict | null;
	delivered: boolean;
	boardDropped: boolean;
	blocker: DropReason;
	closed: boolean;
	timer: unknown;
}

/** A fresh job for `move`; its book membership is still unknown unless the move says so. */
export function newVerdictJob(key: string, move: ClassifiedMove, mine: boolean): VerdictJob {
	const afterFen = applyMoves(move.beforeFen, [move.uci]);
	const previousRoot =
		move.historyMoves.length > 0 ? applyMoves(move.historyFen, move.historyMoves.slice(0, -1)) : null;
	return {
		key,
		move,
		mine,
		beforeKey: reviewKey(move.beforeFen),
		after: afterFen === null ? null : { key: reviewKey(afterFen), fen: afterFen },
		previousKey: previousRoot === null ? null : reviewKey(previousRoot),
		forced: legalMoves(move.beforeFen).length === 1,
		checkmate: afterFen !== null && loadPosition(afterFen)?.isCheckmate() === true,
		landed: null,
		book: move.inBook === true ? true : undefined,
		verdict: null,
		delivered: false,
		boardDropped: false,
		blocker: "no-frame",
		closed: false,
		timer: null,
	};
}

/** The move's "after" position is needed: the "before" frame does not score the move itself. */
export function needsAfter(job: VerdictJob, frames: FrameStore): boolean {
	if (!job.after || legalMoves(job.after.fen).length === 0) return false;
	const before = frames.get(job.beforeKey);
	return !reviewLines(before, MOVE_CLASSIFICATION.minDepth).some(
		(line) => line.pvUci[0] === job.move.uci
	);
}
