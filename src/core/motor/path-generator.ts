/**
 * Human path generation (Appendix G §7.3): cubic Bezier with anchors on the
 * chord normals (one-sided bow ∝ distance), arc-length table, minimum-jerk
 * time profile sampled every `sampleIntervalMs`, Fitts duration floored by
 * the peak-speed cap, overshoot + corrective sub-movement, micro-correction
 * inside the target, AR(1) tremor with a `sin(πτ)` envelope, integer
 * quantisation and a final clamp inside the target rect. The WindMouse style
 * (§2.3) replaces the primary ballistic segment per `styleMix`.
 */

import type { Rng } from "@core/rng";
import { FAST_TOUCH, MIN_JERK, MOTOR_DEFAULTS, PATH } from "./constants";
import { clampIntoRect, inRect, sampleRange } from "./geometry";
import { chooseStyle } from "./motor-profile";
import type { MotorProfile, PathPoint, Pt, Rect } from "./types";
import { windMouseSegment } from "./windmouse";

interface ArcEntry {
	t: number;
	s: number;
}

/** `s(τ) = 10τ³ − 15τ⁴ + 6τ⁵`. */
export function minJerk(t: number): number {
	return t * t * t * (MIN_JERK.c3 + t * (MIN_JERK.c4 + MIN_JERK.c5 * t));
}

/** Direct continuous emergency leg, fitting the supplied clock budget without Fitts/settling floors. */
export function fastPath(from: Pt, to: Pt, durationMs: number): PathPoint[] {
	const steps = Math.max(1, Math.ceil(durationMs / FAST_TOUCH.sampleMs));
	const path: PathPoint[] = [];
	let previous = { x: Math.round(from.x), y: Math.round(from.y) };
	let pending = 0;
	for (let i = 1; i <= steps; i++) {
		const progress = minJerk(i / steps);
		const point = {
			x: Math.round(from.x + (to.x - from.x) * progress),
			y: Math.round(from.y + (to.y - from.y) * progress),
		};
		pending += durationMs / steps;
		if (point.x === previous.x && point.y === previous.y && i !== steps) continue;
		path.push({ ...point, dtMs: pending });
		previous = point;
		pending = 0;
	}
	return path;
}

function cubicBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const c = 3 * u * t * t;
	const d = t * t * t;
	return {
		x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
		y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
	};
}

/** Control points on the chord normals (ghost-cursor style), spread ∝ distance, one-sided bow. */
function bezierAnchors(a: Pt, b: Pt, rng: Rng): [Pt, Pt] {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const d = Math.hypot(dx, dy) || 1;
	const nx = -dy / d;
	const ny = dx / d;
	const spread =
		Math.min(PATH.bezierSpreadPx[1], Math.max(PATH.bezierSpreadPx[0], d)) *
		sampleRange(PATH.bezierSpreadFrac, rng);
	const side = rng.chance(0.5) ? -1 : 1;
	const t1 = sampleRange(PATH.anchorT1, rng);
	const t2 = sampleRange(PATH.anchorT2, rng);
	const s1 = side * spread * sampleRange(PATH.anchorS1, rng);
	const s2 = side * spread * sampleRange(PATH.anchorS2, rng);
	return [
		{ x: a.x + dx * t1 + nx * s1, y: a.y + dy * t1 + ny * s1 },
		{ x: a.x + dx * t2 + nx * s2, y: a.y + dy * t2 + ny * s2 },
	];
}

/** Arc-length lookup (normalised) and the total curve length. */
function arcTable(p0: Pt, p1: Pt, p2: Pt, p3: Pt): { table: ArcEntry[]; length: number } {
	const n = PATH.arcTableSteps;
	const table: ArcEntry[] = [{ t: 0, s: 0 }];
	let prev = p0;
	let acc = 0;
	for (let i = 1; i <= n; i++) {
		const t = i / n;
		const p = cubicBezier(p0, p1, p2, p3, t);
		acc += Math.hypot(p.x - prev.x, p.y - prev.y);
		table.push({ t, s: acc });
		prev = p;
	}
	const length = acc || 1;
	return { table: table.map((e) => ({ t: e.t, s: e.s / length })), length: acc };
}

function tAtArc(table: ArcEntry[], frac: number): number {
	let lo = 0;
	let hi = table.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((table[mid]?.s ?? 1) < frac) lo = mid + 1;
		else hi = mid;
	}
	if (lo === 0) return 0;
	const a = table[lo - 1];
	const b = table[lo];
	if (!a || !b) return 1;
	const k = (frac - a.s) / (b.s - a.s || 1);
	return a.t + (b.t - a.t) * k;
}

/** Fitts (Shannon form) duration in ms, floored by the peak-speed cap and the minimum segment. */
export function fittsMs(distPx: number, widthPx: number, m: MotorProfile, rng: Rng): number {
	const id = Math.log2(distPx / Math.max(PATH.minWidthPx, widthPx) + 1);
	const mt = (m.fittsA + m.fittsB * id) * 1000 * m.travelSpeedScale;
	return Math.max(mt * sampleRange(PATH.fittsJitter, rng), capFloorMs(distPx, m), PATH.minSegmentMs);
}

/** Shortest duration whose nominal minimum-jerk peak stays under the cap (with headroom). */
function capFloorMs(lengthPx: number, m: MotorProfile): number {
	return ((MIN_JERK.peakSpeedFactor * lengthPx) / (m.peakSpeedCapPxPerS * PATH.capHeadroom)) * 1000;
}

/** Shorten a step from `prev` to `q` so it never exceeds `maxStep` (integer result). */
function limitStep(prev: Pt, q: Pt, maxStep: number): Pt {
	const d = Math.hypot(q.x - prev.x, q.y - prev.y);
	if (d <= maxStep) return q;
	const k = (maxStep - PATH.stepLimitMarginPx) / d;
	return { x: Math.round(prev.x + (q.x - prev.x) * k), y: Math.round(prev.y + (q.y - prev.y) * k) };
}

/** Append `q` after `pendingMs + dt`, merging exact duplicates into the pending delay. */
class Emitter {
	private pending = 0;
	private prev: Pt;
	constructor(
		start: Pt,
		private readonly out: PathPoint[],
		private readonly maxStep: number
	) {
		this.prev = { x: Math.round(start.x), y: Math.round(start.y) };
	}
	get position(): Pt {
		return this.prev;
	}
	delay(ms: number): void {
		this.pending += ms;
	}
	push(q: Pt, dtMs: number): void {
		const p = limitStep(this.prev, q, this.maxStep);
		if (p.x === this.prev.x && p.y === this.prev.y) {
			this.pending += dtMs;
			return;
		}
		this.out.push({ x: p.x, y: p.y, dtMs: dtMs + this.pending });
		this.pending = 0;
		this.prev = p;
	}
	/** Walk the remaining distance to `target` in cap-limited steps so the path really lands there. */
	settle(target: Pt, dtMs: number): void {
		for (let i = 0; i < PATH.settleMaxSteps; i++) {
			if (this.prev.x === target.x && this.prev.y === target.y) return;
			this.push(target, dtMs);
		}
	}
	/** Fold any unspent delay into the last emitted point (a slower final approach). */
	flush(): void {
		const last = this.out[this.out.length - 1];
		if (last && this.pending > 0) {
			last.dtMs += this.pending;
			this.pending = 0;
		}
	}
}

/** One ballistic Bezier × minimum-jerk sub-movement from the emitter's position to `b`. */
function bezierSegment(b: Pt, durMs: number, m: MotorProfile, rng: Rng, em: Emitter): void {
	const a = em.position;
	const [c1, c2] = bezierAnchors(a, b, rng);
	const { table, length } = arcTable(a, c1, c2, b);
	const dur = Math.max(durMs, capFloorMs(length, m));
	const n = Math.max(2, Math.round(dur / m.sampleIntervalMs));
	let jx = 0;
	let jy = 0;
	const target = { x: Math.round(b.x), y: Math.round(b.y) };
	const chord = Math.hypot(b.x - a.x, b.y - a.y);
	const [quietPx, fullNoisePx] = PATH.noiseRampPx;
	const noiseScale = Math.min(1, Math.max(0, (chord - quietPx) / (fullNoisePx - quietPx)));
	for (let i = 1; i <= n; i++) {
		const tau = i / n;
		if (i === n) {
			em.settle(target, m.sampleIntervalMs);
			break;
		}
		const p = cubicBezier(a, c1, c2, b, tAtArc(table, minJerk(tau)));
		const env = Math.sin(Math.PI * tau) * noiseScale;
		jx = PATH.tremorRho * jx + rng.normal(0, m.jitterPx);
		jy = PATH.tremorRho * jy + rng.normal(0, m.jitterPx);
		em.push({ x: Math.round(p.x + jx * env), y: Math.round(p.y + jy * env) }, m.sampleIntervalMs);
	}
}

/** WindMouse alternate style for the primary segment, scaled to `durMs`. */
function windSegment(b: Pt, durMs: number, m: MotorProfile, rng: Rng, em: Emitter): void {
	for (const p of windMouseSegment(em.position, b, durMs, m, rng)) em.push(p, p.dtMs);
	em.settle({ x: Math.round(b.x), y: Math.round(b.y) }, m.sampleIntervalMs);
}

/**
 * Humanised path from `from` to `to`, landing inside `targetRect`. Returns an
 * empty path when already at the target.
 */
export function generatePath(
	from: Pt,
	to: Pt,
	targetRect: Rect,
	m: MotorProfile,
	rng: Rng
): PathPoint[] {
	const out: PathPoint[] = [];
	const D = Math.hypot(to.x - from.x, to.y - from.y);
	if (D < 1) return out;
	const W = Math.min(targetRect.width, targetRect.height);
	const dirx = (to.x - from.x) / D;
	const diry = (to.y - from.y) / D;
	const maxStep = (m.peakSpeedCapPxPerS * m.sampleIntervalMs) / 1000;
	const em = new Emitter(from, out, maxStep);
	const style = chooseStyle(m.styleMix, rng);
	const primary = style === "wind" ? windSegment : bezierSegment;

	const overshoot = rng.chance(
		m.overshootProb * Math.min(PATH.overshoot.maxFactor, D / PATH.overshoot.distScalePx)
	);
	if (overshoot) {
		const over = sampleRange(PATH.overshoot.frac, rng) * D + sampleRange(PATH.overshoot.extraPx, rng);
		const o = {
			x: to.x + dirx * over + rng.normal(0, PATH.overshoot.sigmaPx),
			y: to.y + diry * over + rng.normal(0, PATH.overshoot.sigmaPx),
		};
		primary(o, fittsMs(D + over, W * PATH.overshoot.widthFactor, m, rng), m, rng, em);
		em.delay(sampleRange(PATH.overshoot.pauseMs, rng)); // brief pause at the reversal
		bezierSegment(to, sampleRange(PATH.overshoot.correctMs, rng), m, rng, em); // corrective sub-movement
	} else {
		primary(to, fittsMs(D, W, m, rng), m, rng, em);
	}
	if (rng.chance(m.microCorrectionProb)) {
		const cur = em.position;
		const adj = {
			x: cur.x + rng.normal(0, PATH.microCorrection.sigmaPx),
			y: cur.y + rng.normal(0, PATH.microCorrection.sigmaPx),
		};
		if (
			Math.hypot(adj.x - cur.x, adj.y - cur.y) >= PATH.microCorrection.minShiftPx &&
			inRect(adj, targetRect, PATH.microCorrection.padPx)
		) {
			em.delay(sampleRange(PATH.microCorrection.pauseMs, rng));
			bezierSegment(adj, sampleRange(PATH.microCorrection.durMs, rng), m, rng, em);
		}
	}
	em.flush();
	// Safety: the final point must remain inside the target rect — pull it to the nearest
	// interior point rather than snapping to the centre.
	const last = out[out.length - 1];
	if (last && !inRect(last, targetRect, PATH.targetPadPx)) {
		const c = clampIntoRect(last, targetRect, PATH.targetPadPx + 1);
		last.x = Math.round(c.x);
		last.y = Math.round(c.y);
	}
	return out;
}

/** A grip settles along one short direction; never a sequence of unrelated tiny reversals. */
export function grabWobble(p: Pt, m: MotorProfile, rng: Rng): PathPoint[] {
	const n = rng.int(PATH.grabWobble.points[0], PATH.grabWobble.points[1]);
	const sigma = (PATH.grabWobble.sigmaPx * m.jitterPx) / MOTOR_DEFAULTS.jitterPx;
	const intervals: number[] = [];
	let x = p.x;
	let y = p.y;
	for (let i = 0; i < n; i++) {
		x += rng.normal(0, sigma);
		y += rng.normal(0, sigma);
		intervals.push(sampleRange(PATH.grabWobble.dtMs, rng));
	}
	const start = { x: Math.round(p.x), y: Math.round(p.y) };
	const target = limitStep(
		start,
		{ x: Math.round(x), y: Math.round(y) },
		PATH.grabWobble.maxOffsetPx
	);
	const pts: PathPoint[] = [];
	const em = new Emitter(start, pts, (m.peakSpeedCapPxPerS * m.sampleIntervalMs) / 1000);
	for (let i = 0; i < n; i++) {
		const progress = minJerk((i + 1) / n);
		em.push(
			{
				x: Math.round(start.x + (target.x - start.x) * progress),
				y: Math.round(start.y + (target.y - start.y) * progress),
			},
			intervals[i] ?? m.sampleIntervalMs
		);
	}
	em.flush();
	return pts;
}

/** A pause can stay completely still, or contain one bounded adjustment after a quiet interval. */
export function idleTremor(p: Pt, maxMs: number, m: MotorProfile, rng: Rng): PathPoint[] {
	if (maxMs < PATH.idle.minRestMs || !rng.chance(PATH.idle.adjustmentProb)) return [];
	const dtMs = sampleRange(PATH.idle.delayMs, rng);
	if (dtMs > maxMs) return [];
	const sigma = Math.min(PATH.idle.sigmaPx, m.jitterPx);
	const lim = PATH.idle.maxOffsetPx;
	const x = Math.round(p.x + Math.max(-lim, Math.min(lim, rng.normal(0, sigma))));
	const y = Math.round(p.y + Math.max(-lim, Math.min(lim, rng.normal(0, sigma))));
	if (x === Math.round(p.x) && y === Math.round(p.y)) return [];
	return [{ x, y, dtMs }];
}
