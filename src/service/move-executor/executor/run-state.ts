/** The executor's execution slots: a move waiting for its fire time, and the move in the hand. */

import type { ExecutionResult } from "@core/motor/types";
import type { Recommendation } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import type { InputCriticalWindow } from "../input-window";
import type { HoldHandle } from "./scramble-hold";
import type { MoveContext } from "./types";

export interface Pending {
	input: InputCriticalWindow;
	rec: Recommendation;
	timing: TimingPlan;
	ctx: MoveContext;
	fireAt: number;
	timer: unknown;
}

export interface Running {
	rec: Recommendation;
	/** The plan the hand is actually working through (an instant plan for `playNow`/retries). */
	timing: TimingPlan;
	ctx: MoveContext;
	/** The committed mouse-down has entered dispatch, including its acknowledgement wait. */
	committed: boolean;
	ac: AbortController;
	done: Promise<ExecutionResult>;
	/** A scramble hold's decision, until it is made (`MoveContext.holdUntilReply`). */
	hold: HoldHandle | null;
}

/** A `playNow` in flight: a repeated shortcut for the same move joins it instead of restarting. */
export interface FastForward {
	rec: Recommendation;
	version: number;
	done: Promise<ExecutionResult | null>;
}

/** A replacement waiting for a cancelled run to wind down (`cancel()`/`disarm()` drop it). */
export interface Parked {
	rec: Recommendation;
	ac: AbortController;
}
