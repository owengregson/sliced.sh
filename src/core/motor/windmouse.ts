/**
 * WindMouse (SRL-5, BenLand100) — faithful port of Appendix G §2.3: gravity
 * toward the target, low-pass-filtered random wind, velocity clip `maxStep`,
 * damping inside `targetArea`. `windMouseSegment` rescales a run to a given
 * duration for the alternate path style.
 */

import type { Rng } from "@core/rng";
import { WIND } from "./constants";
import type { MotorProfile, PathPoint, Pt } from "./types";

export interface WindMouseParams {
	gravity: number;
	wind: number;
	minWaitMs: number;
	maxWaitMs: number;
	/** px per tick. */
	maxStep: number;
	/** px radius where damping starts. */
	targetArea: number;
}

export function windMousePath(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	p: WindMouseParams,
	rng: Rng
): PathPoint[] {
	const out: PathPoint[] = [];
	const S2 = Math.SQRT2;
	const S3 = Math.sqrt(3);
	const S5 = Math.sqrt(5);
	let xs = x0;
	let ys = y0;
	let vx = 0;
	let vy = 0;
	let wx = 0;
	let wy = 0;
	let wind = p.wind;
	let maxStep = p.maxStep;
	let lastX = Math.round(xs);
	let lastY = Math.round(ys);
	let guard = 0;
	while (Math.hypot(xs - x1, ys - y1) > 1 && guard++ < WIND.maxIterations) {
		const dist = Math.hypot(xs - x1, ys - y1);
		wind = Math.min(wind, dist);
		if (dist >= p.targetArea) {
			wx = wx / S3 + (rng.next() * (wind * 2 + 1) - wind) / S5;
			wy = wy / S3 + (rng.next() * (wind * 2 + 1) - wind) / S5;
		} else {
			wx /= S2;
			wy /= S2;
			maxStep =
				maxStep < WIND.dampedStepFloor
					? rng.next() * WIND.dampedStepRange + WIND.dampedStepFloor
					: maxStep / S5;
		}
		vx += wx + (p.gravity * (x1 - xs)) / dist;
		vy += wy + (p.gravity * (y1 - ys)) / dist;
		const vmag = Math.hypot(vx, vy);
		if (vmag > maxStep) {
			const clip = maxStep / 2 + (rng.next() * maxStep) / 2;
			vx = (vx / vmag) * clip;
			vy = (vy / vmag) * clip;
		}
		xs += vx;
		ys += vy;
		const step = Math.hypot(xs - lastX, ys - lastY);
		const dt = (p.maxWaitMs - p.minWaitMs) * Math.min(1, step / p.maxStep) + p.minWaitMs;
		const rx = Math.round(xs);
		const ry = Math.round(ys);
		if (rx !== lastX || ry !== lastY) {
			out.push({ x: rx, y: ry, dtMs: dt });
			lastX = rx;
			lastY = ry;
		}
	}
	const tx = Math.round(x1);
	const ty = Math.round(y1);
	if (lastX !== tx || lastY !== ty) out.push({ x: tx, y: ty, dtMs: p.minWaitMs });
	return out;
}

function uniform(range: readonly [number, number], rng: Rng): number {
	return range[0] + rng.next() * (range[1] - range[0]);
}

/**
 * One WindMouse run from `a` to `b` with SRL-style randomised parameters,
 * rescaled so that Σdt ≈ `durMs` while no sample exceeds the profile's peak
 * speed cap (those samples keep a longer dt, which lengthens the total slightly).
 */
export function windMouseSegment(
	a: Pt,
	b: Pt,
	durMs: number,
	m: MotorProfile,
	rng: Rng
): PathPoint[] {
	const raw = windMousePath(
		a.x,
		a.y,
		b.x,
		b.y,
		{
			gravity: uniform(WIND.gravity, rng),
			wind: uniform(WIND.wind, rng),
			minWaitMs: WIND.minWaitMs,
			maxWaitMs: WIND.maxWaitMs,
			maxStep: uniform(WIND.maxStep, rng),
			targetArea: uniform(WIND.targetArea, rng),
		},
		rng
	);
	let total = 0;
	for (const p of raw) total += p.dtMs;
	const k = total > 0 ? durMs / total : 1;
	const out: PathPoint[] = [];
	let prev: Pt = { x: Math.round(a.x), y: Math.round(a.y) };
	for (const p of raw) {
		const step = Math.hypot(p.x - prev.x, p.y - prev.y);
		const capMs = (step / m.peakSpeedCapPxPerS) * 1000;
		const dt = Math.max(WIND.minDtMs, p.dtMs * k, capMs);
		out.push({ x: p.x, y: p.y, dtMs: dt });
		prev = p;
	}
	return out;
}
