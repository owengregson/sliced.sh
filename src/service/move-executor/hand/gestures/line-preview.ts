/**
 * The line preview (`LINE_PREVIEW`, `src/core/motor/line-preview.ts`): for each ply of the
 * planned line, travel to the from-square, press the **right** button, drag to the to-square on
 * the same humanised path a left drag uses, release, pause; chess.com draws an arrow per drag
 * and clears them all on the move's own left press.
 */

import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import { log } from "@core/logger";
import { SAMPLING } from "@core/motor/constants";
import { lastPoint } from "@core/motor/geometry";
import { generatePath } from "@core/motor/path-generator";
import { samplePointInRect } from "@core/motor/sampling";
import type { ExecutionPlan, LinePreviewPlan, MotorProfile } from "@core/motor/types";
import { createRng } from "@core/rng";
import { BoardMovedError } from "../errors";
import { boardGeometryOf, guardOf, type PlannedGeometry } from "../geometry";
import type { HandMotor } from "../motor";
import type { Timeline } from "../timeline";

/**
 * Every travel and pause is gated and guarded exactly like the rest of the execution. `untilAt`
 * bounds the gesture: an arrow whose estimate would run past it is not started, so the approach
 * starts on time whatever the paths came to.
 *
 * Nothing here can move a piece, so the exits are gentle: a reflow (`BoardMovedError`) or the
 * time bound simply ends the preview and the move proceeds (the touch is planned afterwards,
 * from fresh geometry when the board moved); a focus veto or a cancel releases the right button
 * where the pointer is — an arrow to nowhere is harmless — and unwinds the execution as it
 * would anywhere else. The right button is released in a `finally`, so it is never left held.
 *
 * Returns whether the hand moved at all (the planned rest path is stale if it did).
 */
export async function previewLine(
	hand: HandMotor,
	plan: ExecutionPlan,
	preview: LinePreviewPlan,
	reply: BoardGeometryReply,
	m: MotorProfile,
	tl: Timeline,
	untilAt: number
): Promise<boolean> {
	const rng = createRng(preview.seed);
	const geo = boardGeometryOf(reply);
	const planned: PlannedGeometry = { board: reply.boardRect, flipped: reply.flipped };
	const guard = guardOf(planned, (r) => hand.guardBoard(r));
	let moved = false;
	tl.begin(EXECUTOR.timelinePhases.linePreview);
	hand.setState("exploring");
	try {
		lines: for (const line of preview.lines) {
			if (hand.now() + line.estimateMs > untilAt) break;
			if (line.beforeMs > 0) await hand.pause(line.beforeMs, guard);
			for (const arrow of line.arrows) {
				if (hand.now() + arrow.estimateMs > untilAt) break lines;
				const fromRect = geo.squareRect(arrow.from);
				const toRect = geo.squareRect(arrow.to);
				const press = samplePointInRect(
					fromRect,
					SAMPLING.press.sigmaFrac,
					SAMPLING.press.innerFrac,
					rng
				);
				const approach = generatePath(hand.position(), press, fromRect, m, rng);
				await hand.travel(approach, guard);
				moved = true;
				await hand.pause(arrow.prePressMs, guard);
				const pressAt = lastPoint(approach, press);
				await hand.pressRight(pressAt, guard);
				try {
					await hand.pause(arrow.pressToDragMs, guard);
					const release = samplePointInRect(
						toRect,
						SAMPLING.release.sigmaFrac,
						SAMPLING.release.innerFrac,
						rng
					);
					await hand.travel(generatePath(pressAt, release, toRect, m, rng), guard);
					await hand.pause(arrow.settleMs, guard);
					guard?.();
				} finally {
					await hand.releaseRight(hand.position());
				}
				hand.record.annotations += 1;
				tl.note(EXECUTOR.timelineNotes.arrow);
				await hand.pause(Math.min(arrow.afterMs, Math.max(0, untilAt - hand.now())), guard);
			}
		}
	} catch (error) {
		if (!(error instanceof BoardMovedError)) throw error;
		// The board moved under an arrow: the arrow (if any) is already released, nothing was
		// submitted, and the touch is re-planned from the geometry the page has now.
		log.debug("hand: the board moved during the line preview; the move proceeds", {
			tabId: plan.tabId,
			arrows: hand.record.annotations,
		});
	} finally {
		tl.begin("decision");
	}
	return moved;
}
