/**
 * The controller's view of the analysis cache: which request a stored result may answer, and the
 * generation that retires every result searched on a network that is no longer loaded.
 */

import { LIMITS } from "@core/constants/limits";
import { SEARCH_BUDGET } from "@core/constants/search";
import type { AnalysisCache } from "@core/engine/analysis-cache";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import type { AnalysisRequest, AnalysisResult } from "@core/engine/types";
import type { EngineVariant } from "@typedefs/engine";

/**
 * Appendix E §4.5: "a hit with depth ≥ requested depthCap − 2 skips the search". The slack is
 * the point — an own-move request carries `depth: depthCap` as a *stop* condition on a
 * `movetime` search, so a cached result is essentially never exactly that deep and requiring it
 * made the cache unreachable for the one path it exists for (a position already analysed during
 * the opponent's turn). Low explicit ceilings remain valid below feature depth `D_f`.
 */
export function minCacheDepth(req: AnalysisRequest, cacheMinDepth: number): number {
	const depth = req.limit.depth;
	if (depth === undefined)
		return req.limit.infinite
			? automaticDepthForElo(req.targetElo ?? req.elo ?? LIMITS.eloMax)
			: cacheMinDepth;
	return Math.min(depth, Math.max(cacheMinDepth, depth - SEARCH_BUDGET.cacheDepthSlack));
}

export class ControllerCache {
	/** Bumped whenever the cache is cleared; a search begun under an older one is not stored. */
	generation = 0;
	private lastLoadedVariant: EngineVariant | undefined;

	constructor(
		private readonly cache: AnalysisCache | undefined,
		private readonly minDepth: number,
		private readonly loadedVariant: (() => EngineVariant | undefined) | undefined
	) {}

	get size(): number {
		return this.cache?.size ?? 0;
	}

	/** Retire every stored result (the network is about to change). */
	invalidate(): void {
		this.generation++;
		this.cache?.clear();
	}

	/** The host may have loaded another network than asked for (a crash fallback): retire the old. */
	refreshNetwork(): void {
		const loaded = this.loadedVariant?.();
		if (loaded === undefined || loaded === this.lastLoadedVariant) return;
		this.lastLoadedVariant = loaded;
		this.invalidate();
	}

	lookup(req: AnalysisRequest): AnalysisResult | undefined {
		if (!this.cache) return undefined;
		// A restricted search is answered from the cache only when it is a Maia-shaped own-move
		// search (H10): its root set is part of the identity, and the pre-analysis of the predicted
		// position asks for exactly the same set. The extra referee search is never answered.
		if (req.searchmoves?.length && req.shaped !== true) return undefined;
		// The human frame is part of the identity (H4): a hit must carry the frame this request asks
		// for, which is why the Maia-mode pre-analysis has to ask for the same `featureDepth`.
		return this.cache.get(
			req.fen,
			req.multiPv,
			minCacheDepth(req, this.minDepth),
			req.elo,
			req.moves,
			req.limit.depth,
			req.featureDepth,
			req.searchmoves
		);
	}

	/** Keep the search history: the same board can have a different repetition outcome. */
	store(result: AnalysisResult): void {
		this.cache?.set(result);
	}
}
