/**
 * Exploration planner (§9.3, §8.4b item 3, §9.3a): the "thinking" behaviour
 * inside the timing plan's pre-touch wait. Phases: orientation drift → scan
 * (hover 1–3 candidate from-squares weighted by selection probability, dwell
 * with micro-drift, occasional trace toward the to-square or a feint over the
 * piece without pressing) → [preview selections at the §9.3a rate] → decision
 * pause (15–40 % of the budget) with an optional idle adjustment. Surplus budget lengthens the
 * orientation and hover dwells rather than the pause. Total = `waitMs −
 * reactionMs`; too short a window yields `[rest]` only. Every action is
 * continuous with the previous one.
 *
 * The two plans live under `./exploration/`: `scan` (no repertoire context) and
 * `repertoire-window` (one purpose per window), built from the gestures in `gestures`.
 */

import type { Rng } from "@core/rng";
import { EXPLORATION } from "./constants";
import { planRepertoireWindow } from "./exploration/repertoire-window";
import { planScan } from "./exploration/scan";
import type { ExplorationOptions } from "./exploration/types";
import { sampleRange } from "./geometry";
import type { RepertoireState } from "./repertoire";
import type { BoardGeometry, HandAction, MotorProfile, MoveCandidate } from "./types";

export { actionDurationMs, actionEnd, planDurationMs } from "./exploration/actions";
export { restPoint } from "./exploration/rest-point";
export type { ExplorationOptions } from "./exploration/types";

export type ExplorationCandidate = MoveCandidate;

export class ExplorationPlanner {
	private repertoireState: RepertoireState | undefined;

	/** A new game must not inherit the preceding game's current attention bout. */
	reset(): void {
		this.repertoireState = undefined;
	}

	plan(
		waitMs: number,
		candidates: readonly MoveCandidate[],
		geometry: BoardGeometry,
		profile: MotorProfile,
		rng: Rng,
		opts: ExplorationOptions
	): HandAction[] {
		const reaction = sampleRange(profile.reactionMs, rng);
		const budget = Number.isFinite(waitMs) ? Math.max(0, waitMs - reaction) : 0;
		if (budget < EXPLORATION.minWindowMs) {
			this.reset();
			return [{ kind: "rest", dwellMs: budget }];
		}
		if (opts.repertoire) {
			const window = planRepertoireWindow(
				budget,
				candidates,
				geometry,
				profile,
				rng,
				opts,
				opts.repertoire,
				this.repertoireState
			);
			this.repertoireState = window.state;
			return window.actions;
		}
		return planScan(budget, waitMs, candidates, geometry, profile, rng, opts);
	}
}
