/**
 * The scan's single gestures: a preview selection wrapped as a hand action, a partial trace
 * toward a destination, and a feint over the piece that never presses.
 */
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { EXPLORATION, SAMPLING } from "../constants";
import { lastPoint, sampleRange, smallRect } from "../geometry";
import { generatePath } from "../path-generator";
import { planPreview } from "../preview-select";
import { samplePointInRect } from "../sampling";
import type {
	BoardGeometry,
	HandAction,
	MotorProfile,
	MoveCandidate,
	PreviewSelection,
	Pt,
	Rect,
} from "../types";
import type { ExplorationOptions } from "./types";

export interface PreviewGesture {
	action: HandAction;
	piece: Square;
	selection: PreviewSelection;
}

/** One preview selection (§9.3a) that fits in `maxMs`, as a `preview` hand action. */
export function previewGesture(
	cursor: Pt,
	candidates: readonly MoveCandidate[],
	geometry: BoardGeometry,
	profile: MotorProfile,
	rng: Rng,
	opts: ExplorationOptions,
	maxMs: number,
	exclude: Square[],
	selected: Square | null
): PreviewGesture | null {
	const input: Parameters<typeof planPreview>[0] = {
		cursor,
		candidates,
		committed: opts.committed,
		geometry,
		legalDestinations: opts.legalDestinations,
		profile,
		maxMs,
		exclude,
		selected,
	};
	if (opts.occupancy) input.occupancy = opts.occupancy;
	const pv = planPreview(input, rng);
	if (!pv) return null;
	return {
		action: {
			kind: "preview",
			target: pv.press,
			rect: pv.pieceRect,
			path: pv.approach,
			dwellMs: pv.totalAfterApproachMs,
			preview: pv,
		},
		piece: pv.piece,
		selection: pv,
	};
}

/** Move part of the way toward the to-square without pressing. */
export function traceGesture(
	cursor: Pt,
	toRect: Rect,
	profile: MotorProfile,
	rng: Rng
): HandAction {
	const toPt = samplePointInRect(toRect, SAMPLING.hover.sigmaFrac, SAMPLING.hover.innerFrac, rng);
	const frac = sampleRange(EXPLORATION.traceFrac, rng);
	const end = {
		x: cursor.x + (toPt.x - cursor.x) * frac,
		y: cursor.y + (toPt.y - cursor.y) * frac,
	};
	const path = generatePath(cursor, end, smallRect(end, EXPLORATION.tracePointRectPx), profile, rng);
	return {
		kind: "trace",
		target: lastPoint(path, end),
		rect: toRect,
		path,
		dwellMs: sampleRange(EXPLORATION.traceDwellMs, rng),
	};
}

/** Pause over the piece as if to grab it, then pull back a little. */
export function feintGesture(cursor: Pt, rect: Rect, profile: MotorProfile, rng: Rng): HandAction {
	const retreat = sampleRange(EXPLORATION.feintRetreatPx, rng);
	const angle = rng.next() * 2 * Math.PI;
	const end = { x: cursor.x + Math.cos(angle) * retreat, y: cursor.y + Math.sin(angle) * retreat };
	const path = generatePath(cursor, end, smallRect(end, EXPLORATION.tracePointRectPx), profile, rng);
	const hold = sampleRange(EXPLORATION.feintDwellMs, rng);
	const first = path[0];
	if (first) first.dtMs += hold;
	return { kind: "feint", target: lastPoint(path, end), rect, path, dwellMs: 0 };
}
