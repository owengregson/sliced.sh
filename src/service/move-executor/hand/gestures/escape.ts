/**
 * The hand's escape legs: what it does when a button is down (or a selection is standing) and the
 * gesture cannot finish where it was aimed. Each one is deliberately ungated and unsignalled — a
 * focus veto or a cancel arriving now would leave the button held over whatever square a stale path
 * reached, which is the very outcome these exist to prevent — and each travels a generated path, so
 * §13.5's pointer continuity and the profile's peak-speed cap still hold: the hand never teleports.
 */

import { ALL_SQUARES } from "@core/chess/squares";
import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import { log } from "@core/logger";
import { SAMPLING } from "@core/motor/constants";
import { lastPoint, rectShiftPx, sampleRange } from "@core/motor/geometry";
import { generatePath } from "@core/motor/path-generator";
import { clickReleasePoint, samplePointInRect } from "@core/motor/sampling";
import type { ExecutionPlan, MotorProfile, Rect } from "@core/motor/types";
import { boardShift } from "@service/board-watch";
import type { Square } from "@typedefs/game";
import { boardGeometryOf, type PlannedGeometry } from "../geometry";
import type { HandMotor } from "../motor";
import type { Timeline } from "../timeline";

/**
 * Put the held piece back where it came from, in the geometry the page has *now*, and let go
 * there: a release on the origin square submits no move on either renderer, which is always
 * better than a move to the wrong square. The return leg is a generated path, so §13.5's
 * pointer continuity and the profile's peak-speed cap both still hold — the hand never
 * teleports. It is deliberately ungated and unsignalled: a focus veto or a cancel arriving now
 * would leave the button held over whatever square the stale path reached, which is the very
 * outcome this exists to prevent.
 */
export async function releaseOnOrigin(
	hand: HandMotor,
	plan: ExecutionPlan,
	live: Rect,
	flipped: boolean,
	m: MotorProfile,
	tl: Timeline
): Promise<void> {
	await releaseOnSquare(
		hand,
		plan.from.square,
		plan.from.rect,
		live,
		{ board: live, flipped },
		m,
		tl
	);
}

/**
 * The escape above, for whichever square the held press landed on — the committed origin or a
 * preview's own piece. `plannedRect` is only for the log line.
 */
export async function releaseOnSquare(
	hand: HandMotor,
	square: Square,
	plannedRect: Rect | null,
	live: Rect,
	planned: PlannedGeometry | null,
	m: MotorProfile,
	tl: Timeline,
	note: string = EXECUTOR.timelineNotes.boardMoved
): Promise<void> {
	tl.note(note);
	tl.begin("correct");
	hand.setState("correcting");
	const origin = boardGeometryOf({
		boardRect: live,
		flipped: planned?.flipped ?? false,
	}).squareRect(square);
	const target = samplePointInRect(
		origin,
		SAMPLING.release.sigmaFrac,
		SAMPLING.release.innerFrac,
		hand.rng
	);
	const path = generatePath(hand.position(), target, origin, m, hand.rng);
	log.info("hand: releasing on the pressed square after a reflow", {
		tabId: hand.tabId,
		square,
		shiftPx: plannedRect ? Math.round(rectShiftPx(plannedRect, origin)) : null,
	});
	await hand.escapeTravel(path);
	await hand.release(lastPoint(path, target));
}

/**
 * The abandon leg of a scramble hold: carry the held piece back to its origin square in the
 * geometry the page has now and let go there. Same primitive as the reflow escape — ungated,
 * unsignalled, a generated path — for the same reason: the button is down and this must finish.
 */
export async function returnToOrigin(
	hand: HandMotor,
	plan: ExecutionPlan,
	planned: PlannedGeometry | null,
	m: MotorProfile,
	tl: Timeline
): Promise<void> {
	if (planned) {
		const live = boardShift(hand.board, hand.tabId, planned.board) ?? planned.board;
		await releaseOnSquare(
			hand,
			plan.from.square,
			plan.from.rect,
			live,
			{ board: live, flipped: planned.flipped },
			m,
			tl,
			EXECUTOR.timelineNotes.holdAbandoned
		);
		return;
	}
	tl.note(EXECUTOR.timelineNotes.holdAbandoned);
	tl.begin("correct");
	hand.setState("correcting");
	const target = { x: plan.from.x, y: plan.from.y };
	const path = generatePath(hand.position(), target, plan.from.rect, m, hand.rng);
	await hand.escapeTravel(path);
	await hand.release(lastPoint(path, target));
}

/**
 * A click-click that could not reach its second click has left the piece selected on the site.
 * Click an idle square — empty, and not a legal destination of the selected piece, so the click
 * can submit nothing (the §9.3a preview's own deselect) — in the geometry the page has now.
 * Without occupancy to choose by, the origin square itself is clicked, which the site reads as
 * toggling the selection off.
 */
export async function clearSelection(
	hand: HandMotor,
	plan: ExecutionPlan,
	reply: BoardGeometryReply | null,
	m: MotorProfile,
	tl: Timeline
): Promise<void> {
	tl.note(EXECUTOR.timelineNotes.selectionCleared);
	tl.begin("correct");
	hand.setState("correcting");
	let live = reply;
	try {
		live = (await hand.readGeometry(plan.tabId)) ?? reply;
	} catch {
		// The geometry read failing is no reason to leave the selection standing.
	}
	const geo = live ? boardGeometryOf(live) : null;
	const occupancy = live?.occupancy;
	const legal = new Set(plan.exploration?.legalDestinations(plan.from.square) ?? []);
	let square: Square = plan.from.square;
	if (occupancy && geo) {
		const idle = ALL_SQUARES.filter(
			(sq) => occupancy[sq] === "empty" && !legal.has(sq) && sq !== plan.to.square
		);
		const pick = idle[hand.rng.int(0, Math.max(0, idle.length - 1))];
		if (pick !== undefined) square = pick;
	}
	const rect = geo ? geo.squareRect(square) : plan.from.rect;
	const target = samplePointInRect(
		rect,
		SAMPLING.press.sigmaFrac,
		SAMPLING.press.innerFrac,
		hand.rng
	);
	const path = generatePath(hand.position(), target, rect, m, hand.rng);
	await hand.escapeTravel(path);
	const at = lastPoint(path, target);
	log.info("hand: clearing the standing selection after an interrupted click-click", {
		tabId: hand.tabId,
		square,
	});
	await hand.pressUngated(at);
	await hand.waitUngated(sampleRange(m.pressHoldMs, hand.rng));
	await hand.release(clickReleasePoint(at, hand.rng));
}
