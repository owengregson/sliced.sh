/**
 * The repertoire plan for a pre-touch window: one purpose for the window (`chooseRepertoire`),
 * a deliberate preview admitted at the §9.3a rate first, else a route of hovers and relating
 * traces with fresh geometry and candidate targets every time.
 */
import type { Rng } from "@core/rng";
import { EXPLORATION, REPERTOIRE, SAMPLING } from "../constants";
import { lastPoint, midpoint, pathMs, sampleRange, smallRect, validRect } from "../geometry";
import { generatePath } from "../path-generator";
import { previewProbability } from "../preview-select";
import {
	chooseRepertoire,
	type MotorRepertoireContext,
	type RepertoireState,
	repertoireRoute,
} from "../repertoire";
import { samplePointInRect } from "../sampling";
import type { BoardGeometry, HandAction, MotorProfile, MoveCandidate, Rect } from "../types";
import { ActionSequence, actionDurationMs } from "./actions";
import { previewGesture } from "./gestures";
import { hoverAnyProb } from "./scan";
import type { ExplorationOptions } from "./types";

export interface RepertoireWindow {
	actions: HandAction[];
	/** The purpose to carry into the next window of this game. */
	state: RepertoireState;
}

/** Plan a `budget` ms window (already net of the reaction time) with the repertoire's purpose. */
export function planRepertoireWindow(
	budget: number,
	candidates: readonly MoveCandidate[],
	geometry: BoardGeometry,
	profile: MotorProfile,
	rng: Rng,
	opts: ExplorationOptions,
	context: MotorRepertoireContext,
	previous: RepertoireState | undefined
): RepertoireWindow {
	const pool = candidates.filter((c) => opts.legalDestinations(c.from).includes(c.to));
	const state = chooseRepertoire(
		{
			...context,
			persona: context.persona ?? opts.persona,
			premovePending: context.premovePending || opts.mode === "premove" || opts.mode === "instant",
		},
		previous,
		{ budgetMs: budget, myClockMs: opts.myClockMs, candidates: pool.length },
		rng
	);
	// A deliberate selection is an inspection bout of its own. Admit it at the
	// existing preview rate before hover appetite, intent filtering, or a route can
	// dilute that rate or consume its budget. Stillness chosen by the repertoire
	// is a preference; urgency and forced-move constraints remain hard guards.
	const previewAllowed =
		!context.forced &&
		!context.premovePending &&
		pool.length > 0 &&
		budget >= REPERTOIRE.minWindowMs &&
		Number.isFinite(opts.myClockMs) &&
		opts.myClockMs >= REPERTOIRE.lowClockMs;
	if (
		previewAllowed &&
		rng.chance(previewProbability({ ...opts, previewBase: profile.exploration.previewBase }))
	) {
		const pauseMs = EXPLORATION.decisionPauseFrac[0] * budget;
		const preview = previewGesture(
			opts.cursor,
			pool,
			geometry,
			profile,
			rng,
			opts,
			budget - pauseMs,
			[],
			null
		);
		if (preview) {
			// Reserve the complete sampled gesture first, including its safe return /
			// deselection. Only then allocate a stationary orientation from the surplus.
			const durationMs = actionDurationMs(preview.action);
			const orientationMs = Math.min(
				sampleRange(REPERTOIRE.orientationFrac, rng) * budget,
				Math.max(0, budget - pauseMs - durationMs)
			);
			return {
				actions: [
					{ kind: "rest", dwellMs: orientationMs },
					preview.action,
					{ kind: "rest", dwellMs: Math.max(0, budget - orientationMs - durationMs) },
				],
				state: { ...state, intent: "inspect" },
			};
		}
	}
	// Retain the fitted profile/time-control appetite; the new repertoire must not
	// restore the old always-hover behavior or ignore a profile with exploration off.
	if (state.intent === "still" || !rng.chance(hoverAnyProb(profile, opts.nReasonable, budget))) {
		return { actions: [{ kind: "rest", dwellMs: budget }], state };
	}
	const seq = new ActionSequence(opts.cursor);
	const pauseMs = sampleRange(EXPLORATION.decisionPauseFrac, rng) * budget;
	const activeUntil = budget - pauseMs;
	seq.push({ kind: "rest", dwellMs: sampleRange(REPERTOIRE.orientationFrac, rng) * activeUntil });
	const route = repertoireRoute(state.intent, pool, rng, opts.committed);
	for (const target of route) {
		const rect: Rect =
			"square" in target
				? geometry.squareRect(target.square)
				: smallRect(
						midpoint(geometry.squareRect(target.between[0]), geometry.squareRect(target.between[1])),
						EXPLORATION.tracePointRectPx
					);
		if (!validRect(rect)) break;
		const point = samplePointInRect(rect, SAMPLING.hover.sigmaFrac, SAMPLING.hover.innerFrac, rng);
		const path = generatePath(seq.cursor, point, rect, profile, rng);
		const dwellRange = state.intent === "verify" ? REPERTOIRE.verifyDwellMs : REPERTOIRE.dwellMs;
		const remaining = activeUntil - seq.spent - pathMs(path);
		// Refuse whole legs. Never accelerate an optional route or cut out its dwell to fit.
		if (remaining < dwellRange[0]) break;
		seq.push({
			kind: "square" in target ? "hover" : "trace",
			rect,
			target: lastPoint(path, point),
			path,
			dwellMs: Math.min(sampleRange(dwellRange, rng), remaining),
		});
	}
	seq.push({ kind: "rest", dwellMs: Math.max(0, budget - seq.spent) });
	return { actions: seq.actions, state };
}
