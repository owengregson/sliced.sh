import { LIMITS } from "@core/constants/limits";
import { HUMAN_DEPTH, SEARCH_BUDGET } from "@core/constants/search";
import { clamp } from "@core/util/clamp";

/**
 * H4 (2026-09-13): the depth of the "what the human sees" frame for the rating Maia is asked
 * about — `HUMAN_DEPTH` knots, flat outside, linear between, rounded. A malformed rating gets
 * the shallowest knot (the frame is only ever a side capture of the same search, never the
 * search's own limit, so a wrong answer here costs nothing but a cache key).
 */
export function humanDepth(selfElo: number): number {
	const first = HUMAN_DEPTH[0];
	const last = HUMAN_DEPTH[HUMAN_DEPTH.length - 1];
	if (first === undefined || last === undefined) return LIMITS.featureDepth;
	if (!Number.isFinite(selfElo) || selfElo <= first[0]) return first[1];
	if (selfElo >= last[0]) return last[1];
	for (let i = 1; i < HUMAN_DEPTH.length; i++) {
		const lo = HUMAN_DEPTH[i - 1];
		const hi = HUMAN_DEPTH[i];
		if (lo === undefined || hi === undefined) continue;
		if (selfElo <= hi[0]) {
			const t = (selfElo - lo[0]) / (hi[0] - lo[0]);
			return Math.round(lo[1] + t * (hi[1] - lo[1]));
		}
	}
	return last[1];
}

/** A resource ceiling, not a playing-strength calibration. Time budgets may stop search earlier. */
export function automaticDepthForElo(targetElo: number): number {
	if (!Number.isFinite(targetElo)) return LIMITS.depthMin;
	if (targetElo > LIMITS.nnueSmallEloMax) return LIMITS.depthMax;
	const fraction = clamp(
		(targetElo - LIMITS.eloMin) / (LIMITS.nnueSmallEloMax - LIMITS.eloMin),
		0,
		1
	);
	return Math.round(
		LIMITS.depthMin + fraction * (SEARCH_BUDGET.automaticDepth.maxSmallDepth - LIMITS.depthMin)
	);
}
