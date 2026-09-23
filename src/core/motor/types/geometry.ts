/** Viewport geometry: points, rects, timed path points and the board the adapter reports. */

import type { Square } from "@typedefs/game";

export interface Pt {
	x: number;
	y: number;
}

/** Viewport CSS px. */
export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** `dtMs` is the delay BEFORE dispatching this point. */
export interface PathPoint {
	x: number;
	y: number;
	dtMs: number;
}

/** Inclusive `[lo, hi]` range sampled uniformly per move. */
export type MsRange = [number, number];

/** Board geometry supplied by the site adapter (§9.5), viewport CSS px. */
export interface BoardGeometry {
	boardRect: Rect;
	squareRect(sq: Square): Rect;
}

/** What a square holds, from the adapter's placement (used to pick safe deselect clicks). */
export type Occupancy = "own" | "enemy" | "empty";
