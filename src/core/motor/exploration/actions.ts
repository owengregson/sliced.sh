/** Hand-action arithmetic shared by the planners and the hand controller. */
import { pathMs } from "../geometry";
import type { HandAction, Pt } from "../types";

export function actionDurationMs(a: HandAction): number {
	return pathMs(a.path) + a.dwellMs;
}

export function planDurationMs(actions: readonly HandAction[]): number {
	let t = 0;
	for (const a of actions) t += actionDurationMs(a);
	return t;
}

/** Where the cursor is after `a` (the hand controller's next start). */
export function actionEnd(a: HandAction, before: Pt): Pt {
	if (a.preview) return a.preview.deselect ? a.preview.deselect.release : a.preview.hoverPoint;
	const last = a.path?.[a.path.length - 1];
	return last ? { x: last.x, y: last.y } : before;
}

/** Dwell that fits in `room` (shrunk to `min` at most), else `null`. */
export function fitDwell(wanted: number, room: number, min: number): number | null {
	if (room < min) return null;
	return Math.min(wanted, room);
}

/** An action list that tracks its running duration and the cursor at its end. */
export class ActionSequence {
	readonly actions: HandAction[] = [];
	spent = 0;

	constructor(public cursor: Pt) {}

	push(a: HandAction): void {
		this.actions.push(a);
		this.spent += actionDurationMs(a);
		this.cursor = actionEnd(a, this.cursor);
	}
}
