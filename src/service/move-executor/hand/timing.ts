/** The timing-plan facts the hand and the executor's plan fitting both read. */

import type { MoveWindowBudget, TimingPlan } from "@typedefs/timing";

/** The §8.4b phase window of a plan (Task 16's `MoveWindowBudget`). */
export type TimingWindow = MoveWindowBudget;

/** Pre-touch budget: every window phase before the approach (§8.4b item 3). */
export function preTouchMsOf(timing: TimingPlan): number {
	const w = timing.window;
	return Math.max(0, w.orientationMs + w.scanMs + w.previewMs + w.decisionMs);
}

export function fastTouch(timing: TimingPlan): boolean {
	return (
		timing.mode === "premove" ||
		(timing.features.clockRace ?? 0) > 0 ||
		(timing.features.loneKing ?? 0) > 0
	);
}

/**
 * A plan the timing model made for a reply the hand anticipated (`features.anticipated`, set when
 * the idle hand was hovering over the moving piece): the hand runs a prepared touch.
 */
export function anticipatedTouch(timing: TimingPlan): boolean {
	return (timing.features.anticipated ?? 0) > 0 && !fastTouch(timing);
}
