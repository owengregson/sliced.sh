/** H8: Maia is the premove gate, never the chooser. */

import { PREMOVE } from "@core/constants/books";
import type { PredictedPolicy } from "./types";

/** Placement + side to move + castling + en passant: the position, not its move counters. */
function positionOf(fen: string): string {
	return fen.split(" ").slice(0, 4).join(" ");
}

/**
 * H8: `true` when `premove` may be armed in `fen` given `policy` — either there is no answer for
 * that position (no gate), or Maia gives the move at least `PREMOVE.maiaMinProb` there.
 */
export function maiaPremoveGate(
	fen: string,
	premove: string,
	policy: PredictedPolicy | undefined
): boolean {
	if (!policy || positionOf(policy.fen) !== positionOf(fen)) return true;
	let p = 0;
	for (const [uci, prob] of policy.result.moves) if (uci === premove) p = Math.max(p, prob);
	return p >= PREMOVE.maiaMinProb;
}
