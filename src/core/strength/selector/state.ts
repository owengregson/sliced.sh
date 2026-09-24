/** The per-game `SelectionState`: created once per game, advanced once per chosen move. */

import type { ChosenMove } from "@typedefs/game";
import { SELECTION_CONSTANTS as C } from "../constants";
import type { SelectionState } from "../types";
import type { Candidate } from "./candidate";

export function createSelectionState(): SelectionState {
	return { top1Streak: 0, blunderDamperLeft: 0, previousOwnMoves: [], tiltMovesLeft: 0 };
}

/** §7.2 step 9's bookkeeping: the streak, the blunder damper, our move memory and the H12 tilt. */
export function advanceSelectionState(
	state: SelectionState,
	pick: Pick<Candidate, "uci" | "rank" | "cpRaw">,
	source: ChosenMove["source"]
): void {
	state.top1Streak = pick.rank === 1 ? state.top1Streak + 1 : 0;
	state.blunderDamperLeft =
		source === "blunder" ? C.blunder.damperMoves : Math.max(0, state.blunderDamperLeft - 1);
	state.previousOwnMoves.push(pick.uci);
	while (state.previousOwnMoves.length > C.prior.previousOwnMovesKept)
		state.previousOwnMoves.shift();
	// H12: what we thought this move was worth, for the next position's tilt trigger; an unscored
	// pick (rank 0) leaves nothing comparable. The tilt, once set, counts down here on every path.
	if (pick.rank === 0) delete state.lastPickCp;
	else state.lastPickCp = pick.cpRaw;
	if (state.tiltMovesLeft > 0) state.tiltMovesLeft -= 1;
}
