import { REVIEW } from "@core/constants/review";
import type { AnalysisRequest } from "@core/engine/types";

/** At most `REVIEW`'s shape: MultiPV, depth and movetime are capped, never raised. */
export function boundedRequest(input: AnalysisRequest): AnalysisRequest {
	const cap = (value: number | undefined, max: number): number =>
		typeof value === "number" && Number.isFinite(value)
			? Math.max(1, Math.min(max, Math.round(value)))
			: max;
	return {
		id: input.id,
		fen: input.fen,
		...(input.moves ? { moves: [...input.moves] } : {}),
		multiPv: cap(input.multiPv, REVIEW.multiPv),
		limit: {
			depth: cap(input.limit.depth, REVIEW.targetDepth),
			movetimeMs: cap(input.limit.movetimeMs, REVIEW.movetimeMs),
		},
		priority: input.priority ?? "panel",
	};
}

/** The reporter's urgency, lower first: `move` > `ponder` > `panel`. */
export function reviewRank(request: AnalysisRequest): number {
	return request.priority === "move" ? 0 : request.priority === "ponder" ? 1 : 2;
}

/** Whether `result` still answers `request` — the same id, position and move history. */
export function answersRequest(
	request: AnalysisRequest,
	result: { id: string; final: { id: string }; request: AnalysisRequest }
): boolean {
	return (
		result.id === request.id &&
		result.final.id === request.id &&
		result.request.fen === request.fen &&
		(result.request.moves ?? []).join(" ") === (request.moves ?? []).join(" ")
	);
}
