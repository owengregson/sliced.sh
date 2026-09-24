/**
 * Promotion (§9.5): look at the picker, then click the piece. The picker rect
 * is read through the same guarded geometry path as the board; when the read
 * fails or the picker never appears (auto-queen) the drag stands as it is and
 * verification decides the outcome — a failed read is never a failed move.
 */

import { EXECUTOR } from "@core/constants/cdp";
import { log } from "@core/logger";
import { SAMPLING } from "@core/motor/constants";
import { lastPoint, pathMs } from "@core/motor/geometry";
import { fastPath, generatePath } from "@core/motor/path-generator";
import { clickReleasePoint, samplePointInRect } from "@core/motor/sampling";
import type { ExecutionPlan, MotorProfile } from "@core/motor/types";
import type { PromoPiece } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import { guardOf, plannedOf } from "../geometry";
import type { HandMotor } from "../motor";
import type { Timeline } from "../timeline";
import { fastTouch } from "../timing";
import { type PromotionBudget, rescalePath } from "../touch-plan";

export async function promote(
	hand: HandMotor,
	plan: ExecutionPlan,
	timing: TimingPlan,
	piece: PromoPiece,
	m: MotorProfile,
	tl: Timeline,
	budget: PromotionBudget,
	releaseAt: number
): Promise<void> {
	tl.begin("promote");
	hand.setState("promoting");
	await hand.pause(budget.lookMs);
	const reply = await hand.readGeometry(plan.tabId, { piece, to: plan.to.square });
	if (reply === null) tl.note(EXECUTOR.timelineNotes.promotionGeometryUnavailable);
	const rect = reply?.promotion ?? null;
	if (!rect) {
		// The picker never appeared (auto-queen preference) or could not be read.
		log.debug("hand: no promotion picker rect; leaving the drop as it is", {
			tabId: plan.tabId,
			read: reply !== null,
		});
		return;
	}
	hand.gate();
	const target = samplePointInRect(
		rect,
		SAMPLING.promotion.sigmaFrac,
		SAMPLING.promotion.innerFrac,
		hand.rng
	);
	const urgent = fastTouch(timing);
	const from = hand.position();
	const raw =
		urgent && timing.mode !== "premove" && !plan.expected.premove
			? fastPath(from, target, budget.travelMs)
			: generatePath(from, target, rect, m, hand.rng);
	const available = Math.max(0, releaseAt - hand.now() - budget.prePressMs - budget.holdMs);
	const path = rescalePath(raw, Math.min(pathMs(raw), available), m, from);
	const guard = guardOf(plannedOf(reply), (r) => hand.guardBoard(r));
	await hand.travel(path, guard);
	// Consume spare reserved time here. A late geometry read never moves the deadline;
	// mandatory physical motion may overrun, and submittedAt records that actual release.
	await hand.pause(Math.max(budget.prePressMs, releaseAt - hand.now() - budget.holdMs), guard);
	const pressAt = lastPoint(path, target);
	await hand.press(pressAt, false, guard);
	await hand.pause(budget.holdMs, guard);
	await hand.release(clickReleasePoint(pressAt, hand.rng));
	hand.record.submittedAt = hand.now();
}
