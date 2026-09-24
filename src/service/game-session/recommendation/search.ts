/** The pipeline's engine searches: one request under the shared deadline, and the shallow retry. */

import { matchingHistory, type PositionHistory } from "@core/chess/history";
import { SEARCH_BUDGET } from "@core/constants/search";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { newId } from "@core/util/ids";
import type { PositionSnapshot } from "@typedefs/game";

import { searchResultBeforeDeadline } from "../search-deadline";
import type { SearchBudget } from "./budget";
import { refereeElo } from "./maia-search";
import type { PipelineEngine, SearchShape } from "./types";

/** Everything about one own-move search except its budget. */
export interface SearchCall {
	snapshot: PositionSnapshot;
	targetElo: number;
	/** Maia's referee search: full strength (`refereeElo`). */
	maia: boolean;
	signal: AbortSignal | undefined;
	history?: PositionHistory | undefined;
	shape?: SearchShape | undefined;
	/** The shared wall-clock deadline; absent ends the search `budget.movetimeMs` from issue. */
	deadlineMs?: number | undefined;
}

export class PipelineSearcher {
	constructor(
		private readonly engine: PipelineEngine,
		private readonly now: () => number
	) {}

	/** Retry a shallow early result only within the original wall-clock budget. */
	async analyse(call: SearchCall, budget: SearchBudget): Promise<AnalysisResult | null> {
		const started = this.now();
		const first = await this.run(call, budget);
		if (!first || call.signal?.aborted) return first;
		if (first.final.depth >= Math.min(SEARCH_BUDGET.retryDepth, budget.depthCap)) return first;
		const remaining = budget.movetimeMs - Math.max(this.now() - started, first.final.timeMs);
		if (remaining < SEARCH_BUDGET.minMovetimeMs) return first;
		log.debug("recommendation: shallow search, retrying once", {
			depth: first.final.depth,
			remainingMs: remaining,
		});
		const retry = await this.run(call, { ...budget, movetimeMs: remaining });
		return retry && retry.final.depth > first.final.depth ? retry : first;
	}

	/**
	 * Run a search with validated history and the shared wall-clock deadline. Restricted
	 * Maia-shaped searches are cacheable by root set; extra candidate searches are not.
	 */
	async run(call: SearchCall, budget: SearchBudget): Promise<AnalysisResult | null> {
		const { snapshot, signal, shape } = call;
		if (signal?.aborted) return null;
		const validHistory = matchingHistory(call.history, snapshot.fen);
		const req: AnalysisRequest = {
			id: newId(),
			targetElo: call.targetElo,
			fen: validHistory?.fen ?? snapshot.fen,
			...(validHistory?.moves.length ? { moves: validHistory.moves } : {}),
			multiPv: budget.multiPv,
			limit: { movetimeMs: Math.round(budget.movetimeMs), depth: budget.depthCap },
			priority: "move",
		};
		// Feature depth is part of the cache identity.
		if (budget.featureDepth !== undefined) req.featureDepth = budget.featureDepth;
		if (shape?.searchmoves.length) {
			req.searchmoves = [...shape.searchmoves];
			if (shape.shaped) req.shaped = true;
			log.debug(
				shape.shaped
					? "recommendation: maia-shaped referee search"
					: "recommendation: maia extra referee search",
				{ searchmoves: req.searchmoves, multiPv: req.multiPv, movetimeMs: req.limit.movetimeMs }
			);
		}
		const elo = refereeElo(call.targetElo, call.maia);
		if (elo !== undefined) req.elo = elo;
		let handle: AnalysisHandle;
		try {
			handle = this.engine.analyse(req);
		} catch (error) {
			log.warn("recommendation: analyse refused", { error: errorMessage(error) });
			return null;
		}
		return searchResultBeforeDeadline(handle, req, {
			deadlineMs: call.deadlineMs ?? this.now() + budget.movetimeMs,
			now: this.now,
			...(signal ? { signal } : {}),
		});
	}
}
