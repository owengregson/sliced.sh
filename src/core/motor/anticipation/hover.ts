/** The hover spell itself: free pointer movement onto our answering piece's square. */

import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { ANTICIPATION as A } from "../constants/anticipation";
import { sampleRange, validRect } from "../geometry";
import { SpellTimeline } from "../opponent-exploration/timeline";
import type {
	OpponentExplorationOptions,
	OpponentExplorationPlan,
} from "../opponent-exploration/types";
import { samplePointInRect } from "../sampling";
import type { Rect } from "../types";

/** Whether `p` rests over `square`'s rect grown by the hover tolerance. */
export function withinHover(
	p: { x: number; y: number },
	rect: { left: number; top: number; width: number; height: number }
): boolean {
	const padX = rect.width * A.hoverToleranceFrac;
	const padY = rect.height * A.hoverToleranceFrac;
	return (
		p.x >= rect.left - padX &&
		p.x <= rect.left + rect.width + padX &&
		p.y >= rect.top - padY &&
		p.y <= rect.top + rect.height + padY
	);
}

/**
 * One hover spell: the hand goes to a point on our answering piece's square and rests there with
 * the ordinary idle tremor. When it is already over the square it just rests. This is free
 * movement only. There is never a button, and the caller cancels it the moment the position
 * changes.
 */
export function planAnticipationHover(
	opts: Pick<
		OpponentExplorationOptions,
		"cursor" | "previousTarget" | "previousSpell" | "profile" | "geometry"
	>,
	square: Square,
	rng: Rng
): OpponentExplorationPlan & { rect: Rect | null } {
	const total = sampleRange(A.dwellMs, rng);
	const timeline = new SpellTimeline(opts, true, { total, spent: 0, activeUntil: total }, rng);
	const rect = opts.geometry.squareRect(square);
	if (!validRect(rect)) {
		timeline.rest(total);
		return {
			actions: timeline.actions,
			durationMs: total,
			lastTarget: null,
			spell: "anticipate",
			rect: null,
		};
	}
	if (withinHover(timeline.cursor, rect)) timeline.dwell(total, "prepare");
	else {
		const target = samplePointInRect(rect, A.hoverSigmaFrac, A.hoverInnerFrac, rng);
		const moved = timeline.travelTo(target, rect, total, {
			kind: "hover",
			activity: "prepare",
			square,
			side: "own",
		});
		if (!moved) timeline.rest(total);
	}
	timeline.rest(Math.max(0, total - timeline.budget.spent));
	return {
		actions: timeline.actions,
		durationMs: total,
		lastTarget: square,
		spell: "anticipate",
		rect,
	};
}
