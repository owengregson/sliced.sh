/** The results the executor itself reports (nothing reached the hand), and the finishing stamp. */

import { EXECUTOR } from "@core/constants/cdp";
import type { ExecutionResult, Pt } from "@core/motor/types";
import type { Recommendation } from "@typedefs/game";

/** A result with nothing dispatched: no attempts, no timeline. */
export function undispatched(
	outcome: "skipped" | "failed" | "aborted",
	reason: string,
	endPoint: Pt | null,
	elapsedMs: number
): ExecutionResult {
	return {
		ok: false,
		outcome,
		reason,
		tier: EXECUTOR.committedTier,
		attempts: 0,
		endPoint: endPoint ?? { x: 0, y: 0 },
		elapsedMs,
		timeline: [],
	};
}

/**
 * Every result the executor emits carries the move it belongs to (`san`, Task 26's
 * Last-action row) and the moment it finished (`at`, which Task 24 keys the played flash on).
 */
export function stamp(rec: Recommendation, result: ExecutionResult, at: number): ExecutionResult {
	return { ...result, at, san: rec.chosen.san };
}

/**
 * Whether the result must tell the pace model to ignore it: the hand ran something other than the
 * plan (a different mode, a retry, a fast-forward) or the plan itself overran its deadline.
 */
export function overridesPace(
	rec: Recommendation,
	timingMode: string,
	result: ExecutionResult,
	fastForwarded: boolean
): boolean {
	const preparationOverrun = (rec.plan.features.preparationOverrunMs ?? 0) > 0;
	const releaseOverrun =
		result.submittedAt !== undefined &&
		result.submittedAt > rec.plan.deadlineMs + EXECUTOR.approachFitToleranceMs;
	return (
		timingMode !== rec.plan.mode ||
		result.attempts > 1 ||
		fastForwarded ||
		preparationOverrun ||
		releaseOverrun
	);
}
