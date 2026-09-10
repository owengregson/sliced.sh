/**
 * Small geometry / range helpers shared by the motor modules (defined once).
 */

import type { Rng } from "@core/rng";
import type { MsRange, PathPoint, Pt, Rect } from "./types";

/** Uniform sample in the inclusive range. */
export function sampleRange(range: MsRange, rng: Rng): number {
	return range[0] + rng.next() * (range[1] - range[0]);
}

/** Σ `dtMs` of a path (0 for `undefined`). */
export function pathMs(path: readonly PathPoint[] | undefined): number {
	let t = 0;
	for (const p of path ?? []) t += p.dtMs;
	return t;
}

/** The last point of a path, or the rounded fallback for an empty path. */
export function lastPoint(path: readonly PathPoint[], fallback: Pt): Pt {
	const p = path[path.length - 1];
	return p ? { x: p.x, y: p.y } : { x: Math.round(fallback.x), y: Math.round(fallback.y) };
}

/** A `size`×`size` rect centred on `p` (a target for short free movements). */
export function smallRect(p: Pt, size: number): Rect {
	return { left: p.x - size / 2, top: p.y - size / 2, width: size, height: size };
}

export function rectCentre(r: Rect): Pt {
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function inRect(p: Pt, r: Rect, pad = 0): boolean {
	return (
		p.x >= r.left + pad &&
		p.x <= r.left + r.width - pad &&
		p.y >= r.top + pad &&
		p.y <= r.top + r.height - pad
	);
}

/**
 * How far two rects differ, in px: the largest of the four edge/size deltas. The
 * board-reflow guard (§9.5) compares the rect the hand planned with against the
 * one the page reports now, and a single number is what a tolerance applies to.
 */
export function rectShiftPx(a: Rect, b: Rect): number {
	return Math.max(
		Math.abs(a.left - b.left),
		Math.abs(a.top - b.top),
		Math.abs(a.width - b.width),
		Math.abs(a.height - b.height)
	);
}

/** Nearest point to `p` at least `pad` inside `r`. */
export function clampIntoRect(p: Pt, r: Rect, pad = 0): Pt {
	return {
		x: Math.min(r.left + r.width - pad, Math.max(r.left + pad, p.x)),
		y: Math.min(r.top + r.height - pad, Math.max(r.top + pad, p.y)),
	};
}
