/**
 * The routed path's queue (a controller with a network configurator): one native search at a
 * time, admitted by priority, each request answered through a `PendingHandle` until its turn.
 */

import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { insertByRank, pendingHandle } from "@service/analysis/handles";

export interface RoutedAnalysis {
	req: AnalysisRequest;
	handle: AnalysisHandle;
	inner: AnalysisHandle | null;
	cancelled: boolean;
	superseded: boolean;
	start(handle: AnalysisHandle | null): void;
	settle(result: AnalysisResult): void;
}

/** Lower is more urgent: an own move, then a ponder, then the panel. */
export function priority(req: AnalysisRequest): number {
	return req.priority === "panel" ? 2 : req.priority === "ponder" ? 1 : 0;
}

/** A queued job whose handle's `stop` is `stop(job)`. */
export function routedJob(
	req: AnalysisRequest,
	stop: (job: RoutedAnalysis) => Promise<void>
): RoutedAnalysis {
	const pending = pendingHandle(req.id, () => stop(job));
	const job: RoutedAnalysis = {
		req,
		inner: null,
		cancelled: false,
		superseded: false,
		start: pending.start,
		settle: pending.settle,
		handle: pending.handle,
	};
	return job;
}

export function enqueueByPriority(queue: RoutedAnalysis[], job: RoutedAnalysis): void {
	insertByRank(queue, job, (queued) => priority(queued.req));
}

/**
 * Whether `req` stops the running job: a ponder always yields, a more urgent request always
 * wins, and an equally urgent one replaces a search that has already begun.
 */
export function supersedes(active: RoutedAnalysis, req: AnalysisRequest): boolean {
	return (
		active.req.priority === "ponder" ||
		priority(req) < priority(active.req) ||
		(active.inner !== null && priority(req) === priority(active.req))
	);
}
