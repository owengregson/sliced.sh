/**
 * The hand's view of the board: square rects from the adapter's geometry reply, the occupancy
 * guard (§9.3 "never double-move") and the coordinate space a touch was planned in, which is what
 * the §9.5 board-reflow guard compares the page's live rect against.
 */

import { fileOf, rankOf } from "@core/chess/squares";
import type { BoardGeometryReply } from "@core/constants/messages";
import type { BoardGeometry, ExecutionPlan, Occupancy, Rect } from "@core/motor/types";
import type { PromoPiece, Square } from "@typedefs/game";

/** Reads board / square / promotion rects on demand (the content adapter over the game port). */
export interface GeometryProvider {
	read(
		tabId: number,
		/** Ask the adapter to wait for the promotion picker on `to` and report its rect. */
		promotion?: { piece: PromoPiece; to: Square },
		signal?: AbortSignal
	): Promise<BoardGeometryReply | null>;
}

/**
 * The from-square must still hold our piece when the adapter reports occupancy
 * (§9.3 "never double-move"): a reply that says otherwise vetoes the touch.
 */
export function positionIntact(
	reply: BoardGeometryReply | null,
	from: Square,
	to?: Square
): boolean {
	const occ = reply?.occupancy;
	if (!occ) return true;
	if (occ[from] !== "own") return false;
	return to === undefined || occ[to] !== "own";
}

/** Square rects from the adapter's reply, derived from the board rect when it sent none. */
export function boardGeometryOf(reply: BoardGeometryReply): BoardGeometry {
	const b = reply.boardRect;
	const w = b.width / 8;
	const h = b.height / 8;
	return {
		boardRect: b,
		squareRect(sq: Square): Rect {
			const own = reply.squares?.[sq];
			if (own) return own;
			const f = reply.flipped ? 7 - fileOf(sq) : fileOf(sq);
			const r = reply.flipped ? rankOf(sq) : 7 - rankOf(sq);
			return { left: b.left + f * w, top: b.top + r * h, width: w, height: h };
		},
	};
}

export function occupancyOf(reply: BoardGeometryReply): ((sq: Square) => Occupancy) | undefined {
	const occ = reply.occupancy;
	if (!occ) return undefined;
	return (sq) => occ[sq] ?? "empty";
}

export interface Rects {
	from: Rect;
	to: Rect;
}

/** The move's square rects in `reply`'s geometry, or the plan's own when there is no reply. */
export function resolveRects(plan: ExecutionPlan, reply: BoardGeometryReply | null): Rects {
	if (!reply) return { from: plan.from.rect, to: plan.to.rect };
	const geo = boardGeometryOf(reply);
	return { from: geo.squareRect(plan.from.square), to: geo.squareRect(plan.to.square) };
}

/** The coordinate space a touch was planned in: what the board-reflow guard compares against. */
export interface PlannedGeometry {
	board: Rect;
	flipped: boolean;
}

/** The coordinate space of `reply`, or `null` when there is no reply to plan in. */
export function plannedOf(reply: BoardGeometryReply | null): PlannedGeometry | null {
	return reply !== null ? { board: reply.boardRect, flipped: reply.flipped } : null;
}

/** The per-point reflow check for a touch planned in `planned`, or nothing when there is no geometry. */
export function guardOf(
	planned: PlannedGeometry | null,
	check: (planned: Rect) => void
): (() => void) | undefined {
	if (!planned) return undefined;
	return () => check(planned.board);
}

export const sameRect = (a: Rect, b: Rect): boolean =>
	a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
