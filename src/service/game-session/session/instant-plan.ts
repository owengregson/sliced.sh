/**
 * The one shape of a move decided *before* its position exists — a §7.4 fast reply, a Fix F
 * premove entered during the opponent's turn, a scramble hold — as opposed to a searched,
 * timing-model-planned recommendation. Such a move has no think of its own: its plan is a single
 * approach window, and its recommendation carries no lines, no evaluation and no depth.
 */

import type { ChosenMove, Recommendation } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";

export interface InstantPlanInput {
	/** The approach window the hand is given (`thinkMs` and `window.approachMs` both). */
	windowMs: number;
	deadlineMs: number;
	rationale: string[];
	/** `clockRacePolicy(…)?.urgency ?? 0`. */
	clockRace: number;
}

/** A `premove`-mode plan: no orientation, scan, preview or decision, only the approach. */
export function instantPlan(input: InstantPlanInput): TimingPlan {
	return {
		thinkMs: input.windowMs,
		mode: "premove",
		preMoveHoverMs: 0,
		dragDurationMs: 0,
		deadlineMs: input.deadlineMs,
		rationale: input.rationale,
		features: { clockRace: input.clockRace },
		orientationMs: 0,
		window: {
			orientationMs: 0,
			scanMs: 0,
			previewMs: 0,
			decisionMs: 0,
			approachMs: input.windowMs,
		},
	};
}

/** The recommendation for a move no search produced: `chosen` played on `fen` under `plan`. */
export function unsearchedRecommendation(
	chosen: ChosenMove,
	plan: TimingPlan,
	computedAt: number,
	fen: string
): Recommendation {
	return {
		chosen,
		lines: [],
		eval: { cp: 0 },
		depth: 0,
		nps: 0,
		plan,
		computedAt,
		fen,
	};
}
