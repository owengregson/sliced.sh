/**
 * The line rule of resigning a lost game (owner's brief, 2026-09-12; knobs in `RESIGN`), over one
 * search frame. `GameSession.shouldResign` adds the once-per-game and settings gates.
 */

import { RESIGN } from "@core/constants/resign";
import type { EvalLine } from "@typedefs/engine";

/**
 * The frame's best line is mate *against* the side to move (`mate < 0`) in at most
 * `RESIGN.maxMateIn` moves, from a search at least `RESIGN.minDepth` deep, and every line of the
 * frame is mated too — nothing escapes. A MultiPV-1 frame (max-strength mode's deep move search) is
 * one line, and there the best move being mated already means every move is: the same rule reads
 * it unchanged.
 */
export function isResignableFrame(lines: readonly EvalLine[]): boolean {
	const best = lines.find((line) => line.multipv === 1) ?? lines[0];
	if (!best) return false;
	const mate = best.score.mate;
	if (mate === undefined || mate >= 0 || -mate > RESIGN.maxMateIn) return false;
	if (best.depth < RESIGN.minDepth) return false;
	return lines.every((line) => line.score.mate !== undefined && line.score.mate < 0);
}
