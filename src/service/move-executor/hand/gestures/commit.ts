/**
 * The committed gesture, from the grab to the submitting release: a drag (with its optional
 * scramble hold over the destination) or — `Settings.execution.inputMode`, the owner's 2026-09-11
 * reversal of the drag-only ruling — a click-click. Both run the same planned touch, so the timing
 * model's window fits either unchanged.
 */

import { SCRAMBLE_HOLD } from "@core/constants/hold";
import type { BoardGeometryReply } from "@core/constants/messages";
import { CLICK, CLICK_MOVE, PATH } from "@core/motor/constants";
import { inRect, sampleRange } from "@core/motor/geometry";
import { generatePath } from "@core/motor/path-generator";
import { clickReleasePoint } from "@core/motor/sampling";
import type { ExecutionPlan, HoldDirective, MotorProfile } from "@core/motor/types";
import { BoardMovedError, HoldAbandonedError } from "../errors";
import { guardOf, type PlannedGeometry, type Rects } from "../geometry";
import type { HandMotor } from "../motor";
import type { Timeline } from "../timeline";
import type { DragTouch } from "../touch-plan";
import { clearSelection, releaseOnOrigin, returnToOrigin } from "./escape";

/**
 * The carry after the grab: travel, hesitate, settle, and a correction leg when the settle left the
 * pointer outside the destination. Shared by the drag (button down) and the click-click (button up).
 */
async function carry(
	hand: HandMotor,
	t: DragTouch,
	rects: Rects,
	m: MotorProfile,
	tl: Timeline,
	guard: (() => void) | undefined
): Promise<void> {
	tl.begin("drag");
	hand.setState("dragging");
	await hand.travel(t.travel, guard);
	if (t.hesitate.length > 0) await hand.travel(t.hesitate, guard);
	tl.begin("drop");
	hand.setState("dropping");
	await hand.pause(t.settleMs, guard);
	if (!inRect(hand.position(), rects.to, PATH.targetPadPx)) {
		tl.begin("correct");
		hand.setState("correcting");
		await hand.travel(generatePath(hand.position(), t.drop, rects.to, m, hand.rng), guard);
		tl.begin("drop");
		hand.setState("dropping");
	}
}

export async function drag(
	hand: HandMotor,
	t: DragTouch,
	rects: Rects,
	m: MotorProfile,
	tl: Timeline,
	plan: ExecutionPlan,
	planned: PlannedGeometry | null
): Promise<void> {
	const guard = guardOf(planned, (r) => hand.guardBoard(r));
	tl.begin("grab");
	hand.setState("grabbing");
	// Still outside the `try`: nothing is committed until the press, so a reflow caught here needs
	// no escape release — it ends the execution with `pressed: false`.
	await hand.pause(t.preGrabMs, guard);
	await hand.press(t.pressAt, true, guard);
	try {
		await hand.pause(t.grabDelayMs, guard);
		await hand.travel(t.wobble, guard);
		await carry(hand, t, rects, m, tl, guard);
		// The last look before the move is submitted: a reflow between the settle and the release
		// is the one that would drop the piece on the wrong square with nothing else noticing.
		guard?.();
		if (plan.hold) {
			// The scramble hold: the piece stays over its destination, button down, until the
			// opponent's move decides its fate. No focus gate and no abort inside the wait itself —
			// both are answered by *abandon*, which carries the piece home before anything else can
			// release it where it is (`recover()` would, and that is the drop this exists to avoid).
			tl.begin("hold");
			hand.setState("holding");
			const decision = await holdUntil(hand, plan.hold);
			if (decision === "abandon") {
				await returnToOrigin(hand, plan, planned, m, tl);
				throw new HoldAbandonedError();
			}
			hand.record.holdReleasedAt = hand.now();
			tl.begin("drop");
			hand.setState("dropping");
			// Seeing their move and letting go are two events, even for a hand already holding the
			// piece over its square. Ungated and unsignalled like the abandon leg: a cancel landing
			// in this pause must not release the piece where it is through `recover()`.
			const [reactMin, reactMax] = SCRAMBLE_HOLD.releaseReactionMs;
			const skew = hand.rng.next() ** 2;
			await hand.waitUngated(reactMin + (reactMax - reactMin) * skew);
		}
	} catch (error) {
		if (error instanceof BoardMovedError) {
			await releaseOnOrigin(hand, plan, error.live, planned?.flipped ?? false, m, tl);
		}
		throw error;
	}
	await hand.release(hand.position());
	hand.record.dropped(hand.now());
}

/** The hold's wait: the directive's decision, or `abandon` the moment the run is cancelled. */
function holdUntil(hand: HandMotor, hold: HoldDirective): Promise<"release" | "abandon"> {
	const signal = hand.signal;
	if (!signal) return hold.decide();
	if (signal.aborted) return Promise.resolve("abandon");
	return new Promise((resolve) => {
		const onAbort = (): void => resolve("abandon");
		signal.addEventListener("abort", onAbort, { once: true });
		hold.decide().then(
			(decision) => {
				signal.removeEventListener("abort", onAbort);
				resolve(decision);
			},
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve("abandon");
			}
		);
	});
}

/**
 * Click-to-move (`Settings.execution.inputMode`): click the piece, let go, carry the pointer over
 * with the button up, click the square. The first click is the committed press — it selects the
 * piece on the site — and the second is what submits, so between the two a selection is
 * *standing*, which §13.7 item 3 forbids leaving behind: any exit from that stretch (a veto, an
 * abort, a reflow) first clicks an idle square to clear it, ungated and unsignalled like the drag's
 * escape release, and only then unwinds. The same touch plan as the drag (approach, press point,
 * travel, drop point, hesitation, settle) so the timing model's window fits it unchanged.
 */
export async function clickClick(
	hand: HandMotor,
	t: DragTouch,
	rects: Rects,
	reply: BoardGeometryReply | null,
	m: MotorProfile,
	tl: Timeline,
	plan: ExecutionPlan,
	planned: PlannedGeometry | null
): Promise<void> {
	const guard = guardOf(planned, (r) => hand.guardBoard(r));
	tl.begin("grab");
	hand.setState("grabbing");
	await hand.pause(t.preGrabMs, guard);
	await hand.press(t.pressAt, true, guard);
	await hand.pause(sampleRange(m.pressHoldMs, hand.rng));
	await hand.release(clickReleasePoint(t.pressAt, hand.rng));
	try {
		await hand.pause(sampleRange(CLICK_MOVE.interClickGapMs, hand.rng), guard);
		await carry(hand, t, rects, m, tl, guard);
		guard?.();
		await hand.pause(sampleRange(CLICK.prePressPauseMs, hand.rng), guard);
	} catch (error) {
		await clearSelection(hand, plan, reply, m, tl);
		throw error;
	}
	// The submitting click: from here the move is the site's, exactly as a drag's release is.
	const at = hand.position();
	await hand.press(at, false);
	hand.record.dropped(hand.now());
	await hand.waitUngated(sampleRange(m.pressHoldMs, hand.rng));
	await hand.release(clickReleasePoint(at, hand.rng));
}
