/**
 * Exploration planner (§9.3, §8.4b item 3, §9.3a): the "thinking" behaviour
 * inside the timing plan's pre-touch wait. Phases: orientation drift → scan
 * (hover 1–3 candidate from-squares weighted by selection probability, dwell
 * with micro-drift, occasional trace toward the to-square or a feint over the
 * piece without pressing) → [preview selections at the §9.3a rate] → decision
 * pause (15–40 % of the budget) with idle tremor. Surplus budget lengthens the
 * orientation and hover dwells rather than the pause. Total = `waitMs −
 * reactionMs`; too short a window yields `[rest]` only. Every action is
 * continuous with the previous one.
 */

import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import type { TimingMode } from "@typedefs/timing";
import { EXPLORATION, PREVIEW, SAMPLING } from "./constants";
import { lastPoint, pathMs, sampleRange, smallRect } from "./geometry";
import { generatePath, idleTremor } from "./path-generator";
import { planPreview, previewProbability, selectedAfter } from "./preview-select";
import { pointInBand, samplePointInRect } from "./sampling";
import type {
	BoardGeometry,
	HandAction,
	MotorProfile,
	MoveCandidate,
	Occupancy,
	PreviewSelection,
	Pt,
	Rect,
	RestStyle,
} from "./types";

export type ExplorationCandidate = MoveCandidate;

export interface ExplorationOptions {
	thinkMs: number;
	mode: TimingMode;
	nReasonable: number;
	myClockMs: number;
	persona: PersonaId;
	/** `Settings.execution.previewSelectScale`, 0 when previews are off. */
	previewScale: number;
	committed: { from: Square; to: Square };
	legalDestinations(sq: Square): Square[];
	/** Adapter placement (Task 18); lets previews pick truly empty squares to deselect. */
	occupancy?: (sq: Square) => Occupancy;
	/** Where the hand is now — it owns the pointer (§13.5), so the caller always knows. */
	cursor: Pt;
}

export function actionDurationMs(a: HandAction): number {
	return pathMs(a.path) + a.dwellMs;
}

export function planDurationMs(actions: readonly HandAction[]): number {
	let t = 0;
	for (const a of actions) t += actionDurationMs(a);
	return t;
}

/** Where the cursor is after `a` (the hand controller's next start). */
export function actionEnd(a: HandAction, before: Pt): Pt {
	if (a.preview) return a.preview.deselect ? a.preview.deselect.release : a.preview.hoverPoint;
	const last = a.path?.[a.path.length - 1];
	return last ? { x: last.x, y: last.y } : before;
}

/** P(any hover): rises with `n_reasonable` and the wait window. */
function hoverAnyProb(profile: MotorProfile, nReasonable: number, waitMs: number): number {
	const [lo, hi] = EXPLORATION.hoverRampMs;
	const ramp = Math.min(1, Math.max(0, (waitMs - lo) / (hi - lo)));
	const n = 1 + EXPLORATION.hoverNSlope * (Math.max(1, nReasonable) - 1);
	return Math.min(EXPLORATION.hoverProbCap, profile.exploration.hoverProb * n * ramp);
}

/**
 * A rest position (§9.4): on/near the dropped piece (`anchor`), near the
 * clock / move list, or just off the board; `mixed` draws by the §4 weights.
 */
export function restPoint(
	geometry: BoardGeometry,
	style: RestStyle,
	anchor: Pt | null,
	rng: Rng
): Pt {
	const w = SAMPLING.startWeights;
	const chosen =
		style === "mixed"
			? rng.weighted(["piece", "clock", "offboard"] as const, [w.ownHalf, w.clock, w.offBoard])
			: style;
	let p: Pt;
	if (chosen === "piece") {
		if (anchor) {
			const lim = EXPLORATION.restPieceMaxPx;
			const dx = Math.max(-lim, Math.min(lim, rng.normal(0, EXPLORATION.restPieceSigmaPx)));
			const dy = Math.max(-lim, Math.min(lim, rng.normal(0, EXPLORATION.restPieceSigmaPx)));
			p = { x: anchor.x + dx, y: anchor.y + dy };
		} else p = pointInBand(geometry.boardRect, "ownHalf", rng);
	} else p = pointInBand(geometry.boardRect, chosen === "clock" ? "clock" : "offBoard", rng);
	return { x: Math.round(p.x), y: Math.round(p.y) };
}

interface Budget {
	spent: number;
	explore: number;
	pauseMs: number;
}

export class ExplorationPlanner {
	plan(
		waitMs: number,
		candidates: readonly MoveCandidate[],
		geometry: BoardGeometry,
		profile: MotorProfile,
		rng: Rng,
		opts: ExplorationOptions
	): HandAction[] {
		const reaction = sampleRange(profile.reactionMs, rng);
		const budget = waitMs - reaction;
		let cursor = opts.cursor;
		if (budget < EXPLORATION.minWindowMs) return [{ kind: "rest", dwellMs: Math.max(0, budget) }];

		const actions: HandAction[] = [];
		const pauseMs = sampleRange(EXPLORATION.decisionPauseFrac, rng) * budget;
		const b: Budget = { spent: 0, explore: budget - pauseMs, pauseMs };
		const push = (a: HandAction): void => {
			actions.push(a);
			b.spent += actionDurationMs(a);
			cursor = actionEnd(a, cursor);
		};

		// Orientation: slow idle drift where the hand rests.
		const orientMs = sampleRange(EXPLORATION.orientationFrac, rng) * b.explore;
		const drift = idleTremor(cursor, orientMs, profile, rng);
		push({ kind: "drift", path: drift, dwellMs: orientMs - pathMs(drift) });

		// Preview decision up front so the scan phase leaves room for it.
		const pPreview = previewProbability({ ...opts, previewBase: profile.exploration.previewBase });
		const wantPreview = rng.chance(pPreview);
		const wantSecond = wantPreview && rng.chance(pPreview * PREVIEW.secondPreviewFactor);
		const reserve = wantPreview ? PREVIEW.reserveMs * (wantSecond ? 2 : 1) : 0;

		// Scan: hover candidate pieces, sometimes trace toward the to-square or feint a grab.
		if (rng.chance(hoverAnyProb(profile, opts.nReasonable, waitMs))) {
			const pool = aggregate(candidates);
			const wanted = rng.weighted([1, 2, 3], EXPLORATION.hoverCountWeights);
			for (let i = 0; i < wanted && pool.length > 0; i++) {
				const idx = weightedIndex(pool, rng);
				const [cand] = pool.splice(idx, 1);
				if (!cand) break;
				const rect = geometry.squareRect(cand.from);
				const target = samplePointInRect(rect, SAMPLING.hover.sigmaFrac, SAMPLING.hover.innerFrac, rng);
				const path = generatePath(cursor, target, rect, profile, rng);
				const remaining = b.explore - b.spent - reserve;
				const dwell = fitDwell(
					sampleRange(EXPLORATION.hoverDwellMs, rng),
					remaining - pathMs(path),
					EXPLORATION.hoverDwellMs[0]
				);
				if (dwell === null) break;
				push({ kind: "hover", target: lastPoint(path, target), rect, path, dwellMs: dwell });
				if (!rng.chance(profile.exploration.feintProb)) continue;
				const feint = cand.from === opts.committed.from && rng.chance(0.5);
				const extra = feint
					? this.feint(cursor, rect, profile, rng)
					: this.trace(cursor, geometry.squareRect(cand.to), profile, rng);
				const room = b.explore - b.spent - reserve - pathMs(extra.path);
				const d = fitDwell(extra.dwellMs, room, 0);
				if (d === null) continue;
				push({ ...extra, dwellMs: d });
			}
		}

		// Preview selections (§9.3a): at most one at default rates, a second with p·0.25.
		// The decision pause may shrink to its minimum to make room for a preview.
		if (wantPreview) {
			b.pauseMs = EXPLORATION.decisionPauseFrac[0] * budget;
			b.explore = budget - b.pauseMs;
			const first = this.preview(cursor, candidates, geometry, profile, rng, opts, b, [], null);
			if (first) {
				push(first.action);
				if (wantSecond) {
					// The first piece may still be selected: its destinations are banned for the second.
					const second = this.preview(
						cursor,
						candidates,
						geometry,
						profile,
						rng,
						opts,
						b,
						[first.piece],
						selectedAfter(first.selection)
					);
					if (second) push(second.action);
				}
			}
		}

		// Surplus (budget − spent − pause) lengthens hover dwells, then the orientation drift,
		// so the decision pause stays inside its 15–40 % band.
		let surplus = budget - b.spent - b.pauseMs;
		for (const a of actions) {
			if (surplus <= 0) break;
			if (a.kind !== "hover") continue;
			const add = Math.min(surplus, EXPLORATION.hoverDwellMs[1] - a.dwellMs);
			if (add <= 0) continue;
			a.dwellMs += add;
			surplus -= add;
		}
		const orientation = actions[0];
		if (surplus > 0 && orientation?.kind === "drift") {
			extendDrift(orientation, surplus, profile, rng);
			surplus = 0;
		}
		b.spent = planDurationMs(actions);

		// Decision pause: rest with idle tremor for whatever remains (= the pause).
		const restMs = Math.max(0, budget - b.spent);
		const tremor = idleTremor(cursor, restMs * EXPLORATION.restTremorFrac, profile, rng);
		const rest: HandAction = { kind: "rest", dwellMs: restMs - pathMs(tremor) };
		if (tremor.length > 0) rest.path = tremor;
		actions.push(rest);
		return actions;
	}

	private preview(
		cursor: Pt,
		candidates: readonly MoveCandidate[],
		geometry: BoardGeometry,
		profile: MotorProfile,
		rng: Rng,
		opts: ExplorationOptions,
		b: Budget,
		exclude: Square[],
		selected: Square | null
	): { action: HandAction; piece: Square; selection: PreviewSelection } | null {
		const input: Parameters<typeof planPreview>[0] = {
			cursor,
			candidates,
			committed: opts.committed,
			geometry,
			legalDestinations: opts.legalDestinations,
			profile,
			maxMs: b.explore - b.spent,
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
	private trace(cursor: Pt, toRect: Rect, profile: MotorProfile, rng: Rng): HandAction {
		const toPt = samplePointInRect(toRect, SAMPLING.hover.sigmaFrac, SAMPLING.hover.innerFrac, rng);
		const frac = sampleRange(EXPLORATION.traceFrac, rng);
		const end = {
			x: cursor.x + (toPt.x - cursor.x) * frac,
			y: cursor.y + (toPt.y - cursor.y) * frac,
		};
		const path = generatePath(
			cursor,
			end,
			smallRect(end, EXPLORATION.tracePointRectPx),
			profile,
			rng
		);
		return {
			kind: "trace",
			target: lastPoint(path, end),
			rect: toRect,
			path,
			dwellMs: sampleRange(EXPLORATION.traceDwellMs, rng),
		};
	}

	/** Pause over the piece as if to grab it, then pull back a little. */
	private feint(cursor: Pt, rect: Rect, profile: MotorProfile, rng: Rng): HandAction {
		const retreat = sampleRange(EXPLORATION.feintRetreatPx, rng);
		const angle = rng.next() * 2 * Math.PI;
		const end = { x: cursor.x + Math.cos(angle) * retreat, y: cursor.y + Math.sin(angle) * retreat };
		const path = generatePath(
			cursor,
			end,
			smallRect(end, EXPLORATION.tracePointRectPx),
			profile,
			rng
		);
		const hold = sampleRange(EXPLORATION.feintDwellMs, rng);
		const first = path[0];
		if (first) first.dtMs += hold;
		return { kind: "feint", target: lastPoint(path, end), rect, path, dwellMs: 0 };
	}
}

/** Lengthen a drift action by `extraMs` with more idle tremor that ends where the drift ended. */
function extendDrift(drift: HandAction, extraMs: number, profile: MotorProfile, rng: Rng): void {
	const path = drift.path ?? [];
	const end = path[path.length - 1];
	if (!end) {
		drift.dwellMs += extraMs;
		return;
	}
	const extra = idleTremor(end, extraMs * EXPLORATION.restTremorFrac, profile, rng);
	const tail = extra[extra.length - 1];
	if (tail) {
		// Return to the original end point so the next action's path still starts there.
		const prev = extra[extra.length - 2] ?? end;
		if (prev.x === end.x && prev.y === end.y) extra.pop();
		else {
			tail.x = end.x;
			tail.y = end.y;
		}
	}
	drift.path = [...path, ...extra];
	drift.dwellMs += extraMs - pathMs(extra);
}

/** Dwell that fits in `room` (shrunk to `min` at most), else `null`. */
function fitDwell(wanted: number, room: number, min: number): number | null {
	if (room < min) return null;
	return Math.min(wanted, room);
}

/** One entry per from-square, probability summed (the hand hovers pieces, not moves). */
function aggregate(cands: readonly MoveCandidate[]): MoveCandidate[] {
	const map = new Map<Square, MoveCandidate>();
	for (const c of cands) {
		const cur = map.get(c.from);
		if (!cur) map.set(c.from, { ...c, probability: Math.max(0, c.probability) });
		else cur.probability += Math.max(0, c.probability);
	}
	return [...map.values()];
}

function weightedIndex(pool: readonly MoveCandidate[], rng: Rng): number {
	const idx = pool.map((_, i) => i);
	const weights = pool.map((c) => c.probability);
	return weights.some((w) => w > 0) ? rng.weighted(idx, weights) : rng.pick(idx);
}
