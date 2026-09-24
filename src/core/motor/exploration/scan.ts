/**
 * The scan plan (§9.3, §8.4b item 3, §9.3a) for a window without a repertoire context:
 * orientation drift → scan (hover 1–3 candidate from-squares weighted by selection probability,
 * dwell, occasional trace toward the to-square or a feint over the piece without pressing) →
 * [preview selections at the §9.3a rate] → decision pause (15–40 % of the budget) with an
 * optional idle adjustment. Surplus budget lengthens the orientation and hover dwells rather than
 * the pause.
 */
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { EXPLORATION, PREVIEW, SAMPLING } from "../constants";
import { lastPoint, pathMs, sampleRange } from "../geometry";
import { generatePath, idleTremor } from "../path-generator";
import { previewProbability, selectedAfter } from "../preview-select";
import { samplePointInRect } from "../sampling";
import type { BoardGeometry, HandAction, MotorProfile, MoveCandidate } from "../types";
import { ActionSequence, fitDwell, planDurationMs } from "./actions";
import { feintGesture, previewGesture, traceGesture } from "./gestures";
import type { ExplorationOptions } from "./types";

/** P(any hover): rises with `n_reasonable` and the wait window. */
export function hoverAnyProb(profile: MotorProfile, nReasonable: number, waitMs: number): number {
	const [lo, hi] = EXPLORATION.hoverRampMs;
	const ramp = Math.min(1, Math.max(0, (waitMs - lo) / (hi - lo)));
	const n = 1 + EXPLORATION.hoverNSlope * (Math.max(1, nReasonable) - 1);
	return Math.min(EXPLORATION.hoverProbCap, profile.exploration.hoverProb * n * ramp);
}

/** Plan a `budget` ms window (already net of the reaction time) opened by a `waitMs` wait. */
export function planScan(
	budget: number,
	waitMs: number,
	candidates: readonly MoveCandidate[],
	geometry: BoardGeometry,
	profile: MotorProfile,
	rng: Rng,
	opts: ExplorationOptions
): HandAction[] {
	const seq = new ActionSequence(opts.cursor);
	const { actions } = seq;
	let pauseMs = sampleRange(EXPLORATION.decisionPauseFrac, rng) * budget;
	let explore = budget - pauseMs;

	// Decide browsing before optional rest adjustments consume random draws.
	const wantHover = rng.chance(hoverAnyProb(profile, opts.nReasonable, waitMs));

	// Orientation: usually a stationary pause where the hand rests.
	const orientMs = sampleRange(EXPLORATION.orientationFrac, rng) * explore;
	const drift = idleTremor(seq.cursor, orientMs, profile, rng);
	seq.push({ kind: "drift", path: drift, dwellMs: orientMs - pathMs(drift) });

	// Preview decision up front so the scan phase leaves room for it.
	const pPreview = previewProbability({ ...opts, previewBase: profile.exploration.previewBase });
	const wantPreview = rng.chance(pPreview);
	const wantSecond = wantPreview && rng.chance(pPreview * PREVIEW.secondPreviewFactor);
	const reserve = wantPreview ? PREVIEW.reserveMs * (wantSecond ? 2 : 1) : 0;

	// Scan: hover candidate pieces, sometimes trace toward the to-square or feint a grab.
	if (wantHover) {
		const pool = aggregate(candidates);
		const wanted = rng.weighted([1, 2, 3], EXPLORATION.hoverCountWeights);
		for (let i = 0; i < wanted && pool.length > 0; i++) {
			const idx = weightedIndex(pool, rng);
			const [cand] = pool.splice(idx, 1);
			if (!cand) break;
			const rect = geometry.squareRect(cand.from);
			const target = samplePointInRect(rect, SAMPLING.hover.sigmaFrac, SAMPLING.hover.innerFrac, rng);
			const path = generatePath(seq.cursor, target, rect, profile, rng);
			const remaining = explore - seq.spent - reserve;
			const dwell = fitDwell(
				sampleRange(EXPLORATION.hoverDwellMs, rng),
				remaining - pathMs(path),
				EXPLORATION.hoverDwellMs[0]
			);
			if (dwell === null) break;
			seq.push({ kind: "hover", target: lastPoint(path, target), rect, path, dwellMs: dwell });
			if (!rng.chance(profile.exploration.feintProb)) continue;
			const feint = cand.from === opts.committed.from && rng.chance(0.5);
			const extra = feint
				? feintGesture(seq.cursor, rect, profile, rng)
				: traceGesture(seq.cursor, geometry.squareRect(cand.to), profile, rng);
			const room = explore - seq.spent - reserve - pathMs(extra.path);
			const d = fitDwell(extra.dwellMs, room, 0);
			if (d === null) continue;
			seq.push({ ...extra, dwellMs: d });
		}
	}

	// Preview selections (§9.3a): at most one at default rates, a second with p·0.25.
	// The decision pause may shrink to its minimum to make room for a preview.
	if (wantPreview) {
		pauseMs = EXPLORATION.decisionPauseFrac[0] * budget;
		explore = budget - pauseMs;
		const preview = (exclude: Square[], selected: Square | null) =>
			previewGesture(
				seq.cursor,
				candidates,
				geometry,
				profile,
				rng,
				opts,
				explore - seq.spent,
				exclude,
				selected
			);
		const first = preview([], null);
		if (first) {
			seq.push(first.action);
			if (wantSecond) {
				// The first piece may still be selected: its destinations are banned for the second.
				const second = preview([first.piece], selectedAfter(first.selection));
				if (second) seq.push(second.action);
			}
		}
	}

	// Surplus (budget − spent − pause) lengthens hover dwells, then the stationary orientation pause,
	// so the decision pause stays inside its 15–40 % band. Each hover is topped up toward a
	// *fresh draw* from `hoverDwellMs` rather than filled to the range's ceiling: filling it
	// meant every hover on a window with time to spare dwelled exactly `hoverDwellMs[1]` —
	// measured at 63 % of hovers over a simulated 3+0 game and 84 % over a 10+0 one, which is
	// a hand that pauses on a piece for the same 0.9 s every single time. Whatever the hovers
	// do not take goes to a stationary orientation pause.
	let surplus = budget - seq.spent - pauseMs;
	for (const a of actions) {
		if (surplus <= 0) break;
		if (a.kind !== "hover") continue;
		const add = Math.min(surplus, sampleRange(EXPLORATION.hoverDwellMs, rng) - a.dwellMs);
		if (add <= 0) continue;
		a.dwellMs += add;
		surplus -= add;
	}
	// Surplus thinking time is a stationary pause at the orientation's endpoint.
	const orientation = actions[0];
	if (surplus > 0 && orientation?.kind === "drift") orientation.dwellMs += surplus;

	// Decision pause: rest with an optional adjustment for whatever remains (= the pause).
	const restMs = Math.max(0, budget - planDurationMs(actions));
	const tremor = idleTremor(seq.cursor, restMs * EXPLORATION.restTremorFrac, profile, rng);
	const rest: HandAction = { kind: "rest", dwellMs: restMs - pathMs(tremor) };
	if (tremor.length > 0) rest.path = tremor;
	actions.push(rest);
	return actions;
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
