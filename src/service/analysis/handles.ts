/**
 * Analysis handles the service worker hands out before — or instead of — a native search. The
 * playing engine's controller and the move-review engine both queue requests of their own and
 * answer with one of these, so a caller never learns whether its search has started yet.
 */

import type {
	AnalysisHandle,
	AnalysisRequest,
	AnalysisResult,
	AnalysisUpdate,
} from "@core/engine/types";

/** A result with no search behind it: no lines, no move, `status` says why. */
export function emptyResult(
	req: AnalysisRequest,
	status: AnalysisResult["status"]
): AnalysisResult {
	return {
		id: req.id,
		bestmove: null,
		request: req,
		status,
		final: { id: req.id, depth: 0, lines: [], nodes: 0, nps: 0, timeMs: 0, complete: false },
	};
}

/** A settled handle: `updates` yields the final frame once, `stop` is a no-op. */
export function cachedHandle(req: AnalysisRequest, hit: AnalysisResult): AnalysisHandle {
	const final: AnalysisUpdate = { ...hit.final, id: req.id };
	const result: AnalysisResult = { ...hit, id: req.id, final, status: "complete", request: req };
	if (hit.atFeatureDepth) result.atFeatureDepth = { ...hit.atFeatureDepth, id: req.id };
	async function* once(): AsyncGenerator<AnalysisUpdate> {
		yield final;
	}
	return {
		id: req.id,
		updates: once(),
		result: Promise.resolve(result),
		stop: () => Promise.resolve(),
	};
}

/** A queued request's outward handle and the two levers its queue pulls. */
export interface PendingHandle {
	handle: AnalysisHandle;
	/** The search began (`inner`), or never will (`null`): `updates` replays `inner`'s, else ends. */
	start(inner: AnalysisHandle | null): void;
	/** Resolve `handle.result`. */
	settle(result: AnalysisResult): void;
}

/** A handle whose search starts later, once its queue calls `start`. */
export function pendingHandle(id: string, stop: () => Promise<void>): PendingHandle {
	let start: (inner: AnalysisHandle | null) => void = () => {};
	let settle: (result: AnalysisResult) => void = () => {};
	const started = new Promise<AnalysisHandle | null>((resolve) => {
		start = resolve;
	});
	const result = new Promise<AnalysisResult>((resolve) => {
		settle = resolve;
	});
	async function* updates(): AsyncGenerator<AnalysisUpdate> {
		const inner = await started;
		if (inner) yield* inner.updates;
	}
	return { start, settle, handle: { id, updates: updates(), result, stop } };
}

/**
 * Insert `item` behind every queued item of the same or a more urgent rank (lower is more
 * urgent): equal ranks keep their arrival order.
 */
export function insertByRank<T>(queue: T[], item: T, rank: (item: T) => number): void {
	const index = queue.findIndex((queued) => rank(queued) > rank(item));
	if (index < 0) queue.push(item);
	else queue.splice(index, 0, item);
}
