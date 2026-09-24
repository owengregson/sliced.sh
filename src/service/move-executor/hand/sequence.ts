/**
 * One execution's choreography (§9.3–§9.5):
 * `rest → orientation → [scan hovers …] → [preview-select …] → [line preview] → decision pause
 * → approach(from) → press → grabWobble → travel(to) → [hesitate] → settle → release
 * → [promotion: look-delay → approach(picker) → click] → post-drop rest`, on the absolute
 * schedule `planMoveWindow` fixes at the start.
 */

import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import { log } from "@core/logger";
import { actionDurationMs, type ExplorationPlanner } from "@core/motor/exploration";
import type { ExecutionPlan } from "@core/motor/types";
import { boardShift } from "@service/board-watch";
import type { TimingPlan } from "@typedefs/timing";
import { SkipError } from "./errors";
import { guardOf, plannedOf, positionIntact, resolveRects, sameRect } from "./geometry";
import { clickClick, drag } from "./gestures/commit";
import { decisionPause, perform, planExploration } from "./gestures/exploration";
import { previewLine } from "./gestures/line-preview";
import { postDropRest } from "./gestures/post-drop-rest";
import { promote } from "./gestures/promotion";
import type { HandMotor } from "./motor";
import { planMoveWindow } from "./move-window";
import type { Timeline } from "./timeline";
import { anticipatedTouch, fastTouch } from "./timing";
import { planPromotion, planTouch } from "./touch-plan";

/** Skip (never dispatch) when the adapter's occupancy says the piece is no longer on `from`. */
function guardPosition(plan: ExecutionPlan, reply: BoardGeometryReply | null): void {
	// Fix F: `expected.premove` means the move is being *entered as a premove*, in the position
	// before the opponent's reply — where its destination is routinely still ours (a recapture
	// is aimed at the piece they are about to take). The from-square is still guarded.
	const to = plan.expected.premove ? undefined : plan.to.square;
	if (positionIntact(reply, plan.from.square, to)) return;
	log.info("hand: from-square no longer holds our piece; skipping", {
		tabId: plan.tabId,
		from: plan.from.square,
	});
	throw new SkipError(EXECUTOR.reasons.positionChanged);
}

export async function runSequence(
	hand: HandMotor,
	planner: ExplorationPlanner,
	plan: ExecutionPlan,
	timing: TimingPlan,
	t0: number,
	tl: Timeline
): Promise<void> {
	const m = plan.motor;
	let reply = plan.geometry?.reply ?? (await hand.readGeometry(plan.tabId));
	let readAt = plan.geometry?.readAt ?? hand.now();
	const promotion = plan.promotion
		? planPromotion(timing, m, resolveRects(plan, reply).to, plan.expected.premove, hand.rng)
		: null;
	const w = planMoveWindow(plan, timing, t0, promotion);
	hand.input.setDeadline(w.reservedApproachAt);

	// Exploration inside the pre-touch window (§9.3 / §9.3a); the trailing decision
	// pause is executed by the controller itself so it can absorb the touch budget.
	// An anticipated reply does not browse either: the hand is on the piece and just reacts.
	const actions =
		fastTouch(timing) || anticipatedTouch(timing)
			? []
			: planExploration(hand, planner, plan, timing, w.exploreMs, reply);
	let tail = actions[actions.length - 1]?.kind === "rest" ? actions.pop() : undefined;
	// The coordinate space the exploration was planned in: a preview **presses** a real square,
	// so its legs need the same reflow guard the committed touch has (below).
	const explored = plannedOf(reply);
	hand.setState("orientation");
	tl.begin("orientation");
	let first = true;
	for (const a of actions) {
		hand.gate();
		// Geometry reads and dispatched events consume this same move window. Optional
		// browsing must yield before it steals the reserved approach/grab/drag/release time.
		// Never start a preview we cannot finish; a held preview must always return safely.
		if (hand.now() + actionDurationMs(a) > w.exploreUntil) break;
		if (!first) {
			hand.setState("exploring");
			tl.begin(a.kind === "preview" ? "preview" : "scan");
		}
		first = false;
		await perform(hand, a, m, explored, tl);
	}

	// Plan the touch from fresh geometry (§9.5) so its duration is known exactly.
	tl.begin("decision");
	if (reply === null || hand.now() - readAt > EXECUTOR.geometryFreshMs) {
		reply = await hand.readGeometry(plan.tabId);
		readAt = hand.now();
	}
	guardPosition(plan, reply);
	let rects = resolveRects(plan, reply);
	if (w.linePreview && reply !== null) {
		// The arrows go out before the touch is planned, bounded by where the approach must start
		// (the approach is fitted into `window.approachMs`, so that is the provisional start), so
		// the touch is planned from wherever the last arrow left the hand.
		const moved = await previewLine(
			hand,
			plan,
			w.linePreview,
			reply,
			m,
			tl,
			w.reservedApproachAt - w.linePreview.restBeforeApproachMs
		);
		// The planned rest was a path from the exploration's end point; the hand is elsewhere now.
		if (moved) tail = undefined;
	}
	let touch = planTouch(plan, w.touchTiming, rects, hand.position(), hand.rng);
	const approachStartAt = Math.max(hand.now(), w.pawnReleaseAt - touch.approachMs - touch.touchMs);
	hand.input.setDeadline(approachStartAt);
	await decisionPause(hand, approachStartAt, tail, m);

	// The pause may have been long, or the page may have moved the board while it ran (the
	// debugger's infobar): re-read once more and re-plan only if the geometry really changed.
	// Nothing is committed yet, so re-planning here is free and there is no continuity to break.
	const movedInPause =
		reply !== null && boardShift(hand.board, plan.tabId, reply.boardRect) !== null;
	if (hand.hasGeometry() && (movedInPause || hand.now() - readAt > EXECUTOR.geometryFreshMs)) {
		const again = await hand.readGeometry(plan.tabId);
		if (again) {
			guardPosition(plan, again);
			const next = resolveRects(plan, again);
			readAt = hand.now();
			reply = again;
			if (!sameRect(next.from, rects.from) || !sameRect(next.to, rects.to)) {
				log.debug("hand: geometry changed before the press; re-planning the touch", {
					movedInPause,
				});
				rects = next;
				touch = planTouch(plan, w.touchTiming, rects, hand.position(), hand.rng);
			}
		}
	}

	hand.gate();
	tl.begin("approach");
	hand.input.commit();
	hand.setState("approaching");
	// The coordinate space the rest of this touch is committed to.
	const planned = plannedOf(reply);
	if (planned && hand.board && hand.board.rect(plan.tabId) === null)
		log.debug("hand: no board rect reported for this tab — the reflow guard is inert", {
			tabId: plan.tabId,
		});
	// The approach is ~`window.approachMs` of travel *after* the geometry re-read and before the
	// committed press. A reflow landing there would press a point that is a different square in
	// the new layout, and the escape release on the origin would then read as a drag from that
	// wrong square — a wrong move, submitted. Nothing is committed yet, so the guard here simply
	// ends the execution with nothing dispatched.
	await hand.travel(
		touch.approach,
		guardOf(planned, (r) => hand.guardBoard(r))
	);
	if (plan.style === "click") await clickClick(hand, touch, rects, reply, m, tl, plan, planned);
	else await drag(hand, touch, rects, m, tl, plan, planned);

	if (plan.promotion && promotion)
		await promote(
			hand,
			plan,
			timing,
			plan.promotion,
			m,
			tl,
			w.autoQueen ? { ...promotion, lookMs: 0 } : promotion,
			w.releaseAt
		);
	hand.input.finish();
	if (!fastTouch(timing)) await postDropRest(hand, plan, reply, m, tl);
}
