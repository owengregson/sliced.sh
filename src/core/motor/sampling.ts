/**
 * Press/release point sampling (Appendix G §7.2) and the plausible start /
 * rest bands (§4). Every stochastic function takes an `Rng`.
 */

import type { Rng } from "@core/rng";
import { CLICK, SAMPLING } from "./constants";
import { inRect, rectCentre, sampleRange } from "./geometry";
import type { Pt, Rect } from "./types";

export { clampIntoRect, inRect, rectCentre } from "./geometry";

/** Gaussian sample rejected outside `[lo, hi]`; falls back to the clamped mean. */
export function truncGauss(mean: number, sigma: number, lo: number, hi: number, rng: Rng): number {
	for (let i = 0; i < SAMPLING.truncGaussTries; i++) {
		const v = rng.normal(mean, sigma);
		if (v >= lo && v <= hi) return v;
	}
	return Math.min(hi, Math.max(lo, mean));
}

/** Random point inside `rect`, Gaussian around the centre, clipped to the inner `innerFrac`. */
export function samplePointInRect(rect: Rect, sigmaFrac: number, innerFrac: number, rng: Rng): Pt {
	const c = rectCentre(rect);
	const hw = (rect.width * innerFrac) / 2;
	const hh = (rect.height * innerFrac) / 2;
	return {
		x: Math.round(truncGauss(c.x, rect.width * sigmaFrac, c.x - hw, c.x + hw, rng)),
		y: Math.round(truncGauss(c.y, rect.height * sigmaFrac, c.y - hh, c.y + hh, rng)),
	};
}

/** Release of a click drifts by at most `CLICK.releaseDriftPx` per axis (integer). */
export function clickReleasePoint(press: Pt, rng: Rng): Pt {
	const d = CLICK.releaseDriftPx;
	return { x: Math.round(press.x) + rng.int(-d, d), y: Math.round(press.y) + rng.int(-d, d) };
}

export type StartBand = "ownHalf" | "clock" | "offBoard";

/** A random point in one of the §4 bands around the board (not yet rounded). */
export function pointInBand(boardRect: Rect, band: StartBand, rng: Rng): Pt {
	const size = boardRect.width / 8;
	if (band === "ownHalf") {
		const file = rng.int(0, 7);
		const row = rng.int(4, 7);
		return samplePointInRect(
			{
				left: boardRect.left + file * size,
				top: boardRect.top + row * size,
				width: size,
				height: size,
			},
			SAMPLING.hover.sigmaFrac,
			SAMPLING.hover.innerFrac,
			rng
		);
	}
	if (band === "clock") {
		return {
			x: boardRect.left + boardRect.width + sampleRange(SAMPLING.clockBandPx, rng),
			y: boardRect.top + rng.next() * boardRect.height,
		};
	}
	const side = rng.int(0, 3);
	const off = sampleRange(SAMPLING.offBoardPx, rng);
	const along = rng.next();
	if (side === 0) return { x: boardRect.left + along * boardRect.width, y: boardRect.top - off };
	if (side === 1)
		return { x: boardRect.left + along * boardRect.width, y: boardRect.top + boardRect.height + off };
	if (side === 2) return { x: boardRect.left - off, y: boardRect.top + along * boardRect.height };
	return { x: boardRect.left + boardRect.width + off, y: boardRect.top + along * boardRect.height };
}

/**
 * A plausible cursor position around the board: 60 % a random square of the
 * user's own (bottom) half, 25 % near the clock / move list to the right,
 * 15 % just off the board edge. Never inside `avoid` (the from-square).
 */
export function plausibleStart(boardRect: Rect, rng: Rng, avoid?: Rect): Pt {
	const w = SAMPLING.startWeights;
	for (let attempt = 0; attempt < 16; attempt++) {
		const band = rng.weighted(["ownHalf", "clock", "offBoard"] as const, [
			w.ownHalf,
			w.clock,
			w.offBoard,
		]);
		const p = pointInBand(boardRect, band, rng);
		const q = { x: Math.round(p.x), y: Math.round(p.y) };
		if (!avoid || !inRect(q, avoid)) return q;
	}
	// Deterministic fallback: just outside the avoided square's top-left corner.
	const a = avoid ?? boardRect;
	return {
		x: Math.round(a.left - SAMPLING.offBoardPx[0]),
		y: Math.round(a.top - SAMPLING.offBoardPx[0]),
	};
}
