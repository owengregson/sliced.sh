/** The search wire commands a request turns into, and the watchdog budget it runs under. */

import { TIMINGS } from "@core/constants/timings";
import type { AnalysisLimit, AnalysisPriority } from "../types";

/** `position fen <fen>[ moves <uci…>]`. */
export function positionCommand(fen: string, moves: readonly string[] | undefined): string {
	const suffix = moves && moves.length > 0 ? ` moves ${moves.join(" ")}` : "";
	return `position fen ${fen}${suffix}`;
}

/** The arguments of `go`: an empty finite limit searches the explicit default movetime. */
export function goArgs(limit: AnalysisLimit, searchmoves: readonly string[] | undefined): string {
	const parts: string[] = [];
	if (limit.infinite) parts.push("infinite");
	else {
		if (limit.depth !== undefined) parts.push(`depth ${limit.depth}`);
		if (limit.movetimeMs !== undefined) parts.push(`movetime ${limit.movetimeMs}`);
		if (limit.nodes !== undefined) parts.push(`nodes ${limit.nodes}`);
		if (parts.length === 0) parts.push(`movetime ${TIMINGS.analysisDefaultMovetimeMs}`);
	}
	if (searchmoves && searchmoves.length > 0) parts.push(`searchmoves ${searchmoves.join(" ")}`);
	return parts.join(" ");
}

/**
 * How long a started search may run before the client stops it itself: a movetime search gets
 * its movetime plus the stop grace, a ponder `TIMINGS.ponderMaxMs`; anything else runs until
 * the engine answers on its own (`undefined`).
 */
export function searchBudget(
	limit: AnalysisLimit,
	priority: AnalysisPriority,
	stopTimeoutMs: number
): number | undefined {
	if (!limit.infinite && limit.movetimeMs !== undefined) return limit.movetimeMs + stopTimeoutMs;
	if (limit.infinite && priority === "ponder") return TIMINGS.ponderMaxMs;
	return undefined;
}
