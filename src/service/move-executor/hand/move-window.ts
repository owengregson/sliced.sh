/**
 * One execution's absolute schedule, anchored at `t0` (§8.4b): where the pawn/piece must be
 * released, where the approach must start, and how much of the pre-touch window exploration may
 * spend once a promotion picker and a line preview have taken their reserves. Pure.
 */

import type { ExecutionPlan, LinePreviewPlan } from "@core/motor/types";
import type { TimingPlan } from "@typedefs/timing";
import { fastTouch, preTouchMsOf } from "./timing";
import type { PromotionBudget } from "./touch-plan";

export interface MoveWindow {
	/** The picker is not expected (auto-queen): nothing is reserved for it. */
	autoQueen: boolean;
	/** The plan the touch is fitted to: the approach budget less the promotion reserve. */
	touchTiming: TimingPlan;
	/** The line preview to draw, when this plan may draw one at all. */
	linePreview: LinePreviewPlan | null;
	/** Pre-touch time the exploration planner may fill. */
	exploreMs: number;
	/** The final, submitting release (the picker click on a promotion). */
	releaseAt: number;
	/** The pawn's (or piece's) drop. */
	pawnReleaseAt: number;
	/** Where the approach must start if the touch takes its whole reserved budget. */
	reservedApproachAt: number;
	/** No exploration action may still be running past this. */
	exploreUntil: number;
}

export function planMoveWindow(
	plan: ExecutionPlan,
	timing: TimingPlan,
	t0: number,
	promotion: PromotionBudget | null
): MoveWindow {
	const preTouchMs = preTouchMsOf(timing);
	const autoQueen = plan.promotion === "q" && timing.promotionPickerExpected === false;
	const promotionReserveMs = autoQueen ? 0 : (promotion?.totalMs ?? 0);
	// The model's motor reserve includes promotion. Spend it once: the pawn must land
	// early enough for the picker release to fit the same, immutable turn deadline.
	const touchTiming =
		promotionReserveMs > 0
			? {
					...timing,
					window: {
						...timing.window,
						approachMs: Math.max(0, timing.window.approachMs - promotionReserveMs),
					},
				}
			: timing;

	// A line preview (`LINE_PREVIEW`) is drawn inside the decision phase, so its reserve comes
	// off the exploration budget: a previewed move hovers less and annotates instead. Only on the
	// plan it was decided for — an instant retry or an urgent plan never draws.
	const linePreview =
		plan.linePreview && !fastTouch(timing) && timing.mode !== "instant" ? plan.linePreview : null;
	const exploreMs = Math.max(0, preTouchMs - (linePreview?.reserveMs ?? 0));
	const releaseAt = Math.min(timing.deadlineMs, t0 + timing.thinkMs);
	const pawnReleaseAt = releaseAt - promotionReserveMs;
	const reservedApproachAt = pawnReleaseAt - touchTiming.window.approachMs;
	const exploreUntil = reservedApproachAt - (linePreview?.reserveMs ?? 0);
	return {
		autoQueen,
		touchTiming,
		linePreview,
		exploreMs,
		releaseAt,
		pawnReleaseAt,
		reservedApproachAt,
		exploreUntil,
	};
}
