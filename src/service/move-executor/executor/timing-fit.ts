/**
 * Fitting a timing plan to the time actually left (§8.4b): the pre-touch window absorbs any loss
 * and the touch budget is kept; an instant plan (`playNow`, retries) keeps only the touch.
 */

import { EXECUTOR } from "@core/constants/cdp";
import { FAST_TOUCH } from "@core/motor/constants";
import type { TimingPlan } from "@typedefs/timing";
import { fastTouch, preTouchMsOf, type TimingWindow } from "../hand/timing";

/**
 * The plan with its pre-touch window resized to `preTouchMs`: phases scale
 * proportionally (orientation alone when the plan had no pre-touch time) and
 * the approach budget is kept.
 */
function withPreTouch(plan: TimingPlan, preTouchMs: number): TimingPlan {
	const w: TimingWindow = plan.window;
	const current = preTouchMsOf(plan);
	const scale = current > 0 ? preTouchMs / current : 0;
	const window: TimingWindow =
		current > 0
			? {
					orientationMs: w.orientationMs * scale,
					scanMs: w.scanMs * scale,
					previewMs: w.previewMs * scale,
					decisionMs: w.decisionMs * scale,
					approachMs: w.approachMs,
				}
			: {
					orientationMs: preTouchMs,
					scanMs: 0,
					previewMs: 0,
					decisionMs: 0,
					approachMs: w.approachMs,
				};
	return { ...plan, preMoveHoverMs: preTouchMs, window };
}

/** An instant plan for `playNow` and retries: no exploration, touch only. */
export function instantTiming(plan: TimingPlan): TimingPlan {
	const urgent = fastTouch(plan);
	const floor = urgent ? fastFloor(plan) : EXECUTOR.minExecutionMs;
	const natural = Math.max(floor, plan.window.approachMs);
	const thinkMs = urgent && plan.thinkMs > 0 ? Math.min(plan.thinkMs, natural) : natural;
	return {
		...withPreTouch(plan, 0),
		mode: plan.mode === "premove" ? "premove" : "instant",
		thinkMs,
		window: {
			orientationMs: 0,
			scanMs: 0,
			previewMs: 0,
			decisionMs: 0,
			approachMs: thinkMs,
		},
	};
}

/**
 * The plan the hand runs when only `availableMs` remain until the deadline:
 * the touch budget is kept and the pre-touch window absorbs the loss.
 */
export function fitTiming(plan: TimingPlan, availableMs: number): TimingPlan {
	if (availableMs >= plan.thinkMs) return plan;
	// A positive remaining window is still the original release deadline. Physical motion
	// limits belong to the hand; padding here silently turns short samples into a fixed floor.
	const thinkMs = availableMs > 0 ? availableMs : fastTouch(plan) ? fastFloor(plan) : 0;
	const touchBudget = Math.min(plan.window.approachMs, thinkMs);
	const preTouch = Math.max(0, Math.min(preTouchMsOf(plan), thinkMs - touchBudget));
	const fitted = withPreTouch(plan, preTouch);
	return {
		...fitted,
		thinkMs,
		dragDurationMs: Math.min(plan.dragDurationMs, touchBudget),
		window: { ...fitted.window, approachMs: thinkMs - preTouch },
	};
}

/** Transport delay may shorten an urgent plan, never inflate it to a repeated execution floor. */
function fastFloor(plan: TimingPlan): number {
	return Math.min(FAST_TOUCH.minBudgetMs, plan.thinkMs > 0 ? plan.thinkMs : FAST_TOUCH.minBudgetMs);
}
