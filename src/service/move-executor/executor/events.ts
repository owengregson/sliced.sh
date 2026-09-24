/** What the executor publishes, and the listener registry that publishes it. */

import { log } from "@core/logger";
import type { ExecutionResult, HandState } from "@core/motor/types";
import { errorMessage } from "@core/util/errors";
import type { GameSessionView } from "@typedefs/game";
import type { InputCriticalUpdate } from "../input-window";
import type { ExecutionReport } from "./types";

export interface ExecutorEvents {
	/** Classification-only admission; background review search may continue throughout input. */
	inputCritical: InputCriticalUpdate;
	executed: ExecutionReport;
	/** Fix F: a premove gesture the hand completed during the opponent's turn (`MoveContext`). */
	dispatched: ExecutionReport;
	failed: ExecutionReport;
	aborted: ExecutionReport;
	skipped: ExecutionReport;
	hand: HandState;
	/**
	 * Fix D: one event per point the renderer has *acknowledged* — the tap the page-side pointer
	 * mirror is fed from, so what the owner sees is what the page was told rather than a plan.
	 * Viewport CSS px (the space `Input.dispatchMouseEvent` takes), rounded as dispatched, with
	 * the left-button state that command carried. The rate is the hand's own: 33-53 points/s over a
	 * move, gap p50 ~7 ms and p90 ~33 ms, with the long tail being its deliberate pauses
	 * (`GameSession.onHandPointer` carries the full measurement and why nothing is coalesced).
	 */
	pointer: { x: number; y: number; pressed: boolean };
}
export type ExecutorEvent = keyof ExecutorEvents;

/** How the executor's parts publish: always through `MoveExecutor.emit`, looked up per call. */
export type Emit = <E extends ExecutorEvent>(event: E, payload: ExecutorEvents[E]) => void;

/** The terminal event a result is published as. */
export function outcomeEvent(
	outcome: ExecutionResult["outcome"]
): "executed" | "dispatched" | "aborted" | "skipped" | "failed" {
	return outcome === "executed"
		? "executed"
		: outcome === "dispatched"
			? "dispatched"
			: outcome === "aborted"
				? "aborted"
				: outcome === "skipped"
					? "skipped"
					: "failed";
}

/** The panel's hand pill (§9.7) for each hand state. */
export const HAND_VIEW: Record<HandState, GameSessionView["hand"]> = {
	rest: "resting",
	orientation: "exploring",
	exploring: "exploring",
	approaching: "moving",
	grabbing: "moving",
	dragging: "moving",
	dropping: "moving",
	correcting: "moving",
	promoting: "moving",
	holding: "moving",
};

/** Per-event listener sets; a throwing listener is logged and never stops the others. */
export class ExecutorListeners {
	private readonly listeners = new Map<ExecutorEvent, Set<(payload: never) => void>>();

	on<E extends ExecutorEvent>(event: E, cb: (payload: ExecutorEvents[E]) => void): () => void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(cb as (payload: never) => void);
		return () => void set?.delete(cb as (payload: never) => void);
	}

	emit<E extends ExecutorEvent>(event: E, payload: ExecutorEvents[E]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const cb of [...set]) {
			try {
				(cb as (p: ExecutorEvents[E]) => void)(payload);
			} catch (error) {
				log.warn("executor: listener threw", { event, error: errorMessage(error) });
			}
		}
	}

	clear(): void {
		this.listeners.clear();
	}
}
