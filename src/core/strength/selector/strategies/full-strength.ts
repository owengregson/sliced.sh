/** Above the Maia cutoff: the full network's strongest guarded continuation is the move. */

import { MAIA } from "@core/constants/maia";
import type { ChosenMove } from "@typedefs/game";
import { finishPick, type SelectionFrame, toCandidate } from "../frame";

/**
 * Above the Maia cutoff — the product's one strength division (owner, 2026-09-15) — the full
 * network's strongest guarded continuation is the move, whatever policy answer is on hand.
 */
export function selectFullStrength(frame: SelectionFrame): ChosenMove | null {
	if (frame.ctx.targetElo <= MAIA.eloMax) return null;
	const best = frame.ranked[0];
	if (!best) throw new RangeError("selectMove: no lines");
	frame.rationale.push(
		frame.maxStrength
			? "full-strength engine: max strength: the engine's best move"
			: "full-strength engine: strongest guarded continuation"
	);
	return finishPick(frame, toCandidate(frame, best), "engine-elo");
}
