/**
 * The pre-touch window (§9.3 / §9.3a): the exploration planner's scan hovers and preview
 * selections, and the trailing decision pause, which the hand runs itself so it can absorb the
 * touch budget.
 */

import type { BoardGeometryReply } from "@core/constants/messages";
import { EXPLORATION } from "@core/motor/constants";
import type { ExplorationOptions, ExplorationPlanner } from "@core/motor/exploration";
import { pathMs, sampleRange } from "@core/motor/geometry";
import { idleTremor } from "@core/motor/path-generator";
import type { ExecutionPlan, HandAction, MotorProfile } from "@core/motor/types";
import type { TimingPlan } from "@typedefs/timing";
import { BoardMovedError } from "../errors";
import { boardGeometryOf, guardOf, occupancyOf, type PlannedGeometry } from "../geometry";
import type { HandMotor } from "../motor";
import type { Timeline } from "../timeline";
import { releaseOnSquare } from "./escape";

export function planExploration(
	hand: HandMotor,
	planner: ExplorationPlanner,
	plan: ExecutionPlan,
	timing: TimingPlan,
	preTouchMs: number,
	reply: BoardGeometryReply | null
): HandAction[] {
	const ex = plan.exploration;
	if (!ex || !reply || preTouchMs <= 0) return [{ kind: "rest", dwellMs: 0 }];
	const geo = boardGeometryOf(reply);
	const opts: ExplorationOptions = {
		...(ex.repertoire ? { repertoire: ex.repertoire } : {}),
		thinkMs: timing.thinkMs,
		mode: timing.mode,
		nReasonable: ex.nReasonable,
		myClockMs: ex.myClockMs,
		persona: ex.persona,
		previewScale: ex.previewScale,
		committed: { from: plan.from.square, to: plan.to.square },
		legalDestinations: ex.legalDestinations,
		cursor: hand.position(),
	};
	const occupancy = occupancyOf(reply);
	if (occupancy) opts.occupancy = occupancy;
	return planner.plan(preTouchMs, ex.candidates, geo, plan.motor, hand.rng, opts);
}

/**
 * Every pause of a preview was sampled by the planner (its budget already counts them).
 *
 * §9.5: a preview **presses** a real square, so its legs carry the same board-reflow guard as
 * the committed touch. The planner guarantees that no press lands on a legal destination of
 * whatever is selected at that moment — but only in the geometry it planned in: after a reflow
 * the same coordinates are different squares, the press/deselect pair can become a legal move,
 * and a held preview press released where a stale path ended is a `mousedown` on one square and
 * a `mouseup` on another — a submitted move. Worse than the committed case, because
 * `pressedCommitted` stays false, so nothing re-checks the board afterwards and `guardPosition`
 * would report a *skip* while a move had in fact been played.
 *
 * A plain hover is deliberately left unguarded: nothing is pressed, so the worst a stale path
 * can do is hover over the wrong squares, and the touch is re-planned from fresh geometry
 * immediately afterwards — aborting there would throw away a move window for a cosmetic loss.
 */
export async function perform(
	hand: HandMotor,
	a: HandAction,
	m: MotorProfile,
	planned: PlannedGeometry | null,
	tl: Timeline
): Promise<void> {
	if (a.kind === "preview" && a.preview) {
		const pv = a.preview;
		const guard = guardOf(planned, (r) => hand.guardBoard(r));
		// Outside the try: nothing is held yet, so a reflow caught here needs no escape.
		await hand.travel(pv.approach, guard);
		await hand.pause(pv.prePressMs, guard);
		await hand.press(pv.press, false, guard);
		// §13.2 counts *pieces* the page saw selected, so the record is written once the press is
		// out — not before, where an aborted approach would claim a selection that never happened.
		hand.record.previewed.push(pv.piece);
		try {
			await hand.pause(pv.holdMs, guard);
			if (pv.dragPath) {
				await hand.pause(pv.grabDelayMs ?? sampleRange(m.grabDelayMs, hand.rng), guard);
				await hand.travel(pv.dragPath, guard);
				await hand.pause(pv.settleMs ?? sampleRange(m.releaseSettleMs, hand.rng), guard);
			}
			// The last look before the button comes up.
			guard?.();
		} catch (error) {
			if (error instanceof BoardMovedError)
				await releaseOnSquare(hand, pv.piece, pv.pieceRect, error.live, planned, m, tl);
			throw error;
		}
		await hand.release(pv.release);
		await hand.travel(pv.hoverPath, guard);
		await hand.pause(pv.dwellMs, guard);
		const d = pv.deselect;
		if (d) {
			await hand.travel(d.path, guard);
			await hand.pause(d.prePressMs, guard);
			await hand.press(d.press, false, guard);
			// The resolving click counts as a selection only in the `switch-to-idle` form, where
			// the square it clicks is an own piece (an empty / enemy square only clears one).
			if (d.occupancy === "own") hand.record.previewed.push(d.square);
			try {
				await hand.pause(d.holdMs, guard);
				guard?.();
			} catch (error) {
				if (error instanceof BoardMovedError)
					await releaseOnSquare(hand, d.square, null, error.live, planned, m, tl);
				throw error;
			}
			await hand.release(d.release);
		}
		return;
	}
	if (a.path) await hand.travel(a.path);
	if (a.dwellMs > 0) await hand.pause(a.dwellMs);
}

export async function decisionPause(
	hand: HandMotor,
	untilAt: number,
	tail: HandAction | undefined,
	m: MotorProfile
): Promise<void> {
	const restMs = untilAt - hand.now();
	if (restMs <= 0) return;
	const tremor =
		tail?.path && pathMs(tail.path) <= restMs
			? tail.path
			: idleTremor(hand.position(), restMs * EXPLORATION.restTremorFrac, m, hand.rng);
	await hand.travel(tremor);
	await hand.sleepUntil(untilAt);
}
