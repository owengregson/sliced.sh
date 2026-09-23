/** How a hand execution reports itself: the shared result fields and the unwinding verdicts. */

import { EXECUTOR } from "@core/constants/cdp";
import { log } from "@core/logger";
import type { ExecutionPlan, ExecutionResult } from "@core/motor/types";
import { errorMessage } from "@core/util/errors";
import { isAbortedError } from "@core/util/scheduler";
import { BoardMovedError, HoldAbandonedError, SkipError } from "./errors";
import type { HandMotor } from "./motor";
import type { Timeline } from "./timeline";

export type ResultBase = Pick<
	ExecutionResult,
	| "tier"
	| "endPoint"
	| "elapsedMs"
	| "startedAt"
	| "submittedAt"
	| "timeline"
	| "pressed"
	| "san"
	| "pointerOffsetPx"
	| "previewedSquares"
	| "pressedAny"
	| "annotations"
>;

/** The fields every outcome carries, read from the hand at the moment the result is built. */
export function resultBaseOf(
	hand: HandMotor,
	plan: ExecutionPlan,
	t0: number,
	tl: Timeline,
	startedPx: number
): () => ResultBase {
	const record = hand.record;
	return () => ({
		tier: plan.style ?? EXECUTOR.committedTier,
		endPoint: hand.backend.position(),
		elapsedMs: (record.dropAt ?? hand.now()) - (record.holdReleasedAt ?? t0),
		startedAt: record.holdReleasedAt ?? t0,
		...(record.submittedAt === null ? {} : { submittedAt: record.submittedAt }),
		...(record.annotations > 0 ? { annotations: record.annotations } : {}),
		timeline: tl.entries,
		pressed: record.pressedCommitted,
		pressedAny: record.pressedAny,
		san: plan.expected.san ?? plan.expected.uci,
		pointerOffsetPx: (hand.backend.travelledPx?.() ?? 0) - startedPx,
		previewedSquares: [...record.previewed],
	});
}

/** The outcome of an execution that unwound with `error` (after `recover()` has run). */
export function unwoundResult(
	error: unknown,
	signal: AbortSignal,
	plan: ExecutionPlan,
	attempts: number,
	base: () => ResultBase
): ExecutionResult {
	if (error instanceof SkipError) {
		log.info("hand: skipped mid-window", { tabId: plan.tabId, reason: error.reason });
		return { ok: false, outcome: "skipped", reason: error.reason, attempts, ...base() };
	}
	if (error instanceof BoardMovedError) {
		// The piece was put back on its origin square (or never pressed a second time), so
		// nothing was submitted. An abort with its own reason lets the executor's re-check
		// confirm that truthfully and the session fall back to `recommended`.
		log.warn("hand: the board moved under the touch; nothing was submitted", {
			tabId: plan.tabId,
			live: error.live,
		});
		return {
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.boardMoved,
			attempts,
			...base(),
		};
	}
	if (error instanceof HoldAbandonedError) {
		// The piece is back on its square: the abandon leg released it there before throwing.
		log.info("hand: the scramble hold was given up; the piece went back", { tabId: plan.tabId });
		return {
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.holdAbandoned,
			attempts,
			...base(),
		};
	}
	if (isAbortedError(error) || signal.aborted) {
		return {
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.aborted,
			attempts: 1,
			...base(),
		};
	}
	const message = errorMessage(error);
	log.warn("hand: execution failed", { tabId: plan.tabId, error: message });
	return {
		ok: false,
		outcome: "failed",
		reason: EXECUTOR.reasons.dispatchFailed,
		attempts: 1,
		error: message,
		...base(),
	};
}
