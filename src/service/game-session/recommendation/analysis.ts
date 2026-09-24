/**
 * Analysis acquisition. An early policy answer shapes one search over its roots and known engine
 * continuations (found by a short anchor search when none are known). Without one, search broadly
 * and consider extra candidates only if time remains (`scoreExtraCandidates`).
 */

import { legalMoves } from "@core/chess/san";
import { MAIA_SEARCH, SEARCH_BUDGET } from "@core/constants/search";
import type { AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import type { PolicyResult } from "@core/policy/types";
import type { EvalLine } from "@typedefs/engine";

import { clockBoundSearch, extraSearchMs } from "./budget";
import type { OwnMoveContext, PreparationWindow } from "./context";
import { mergeLines, usableLines } from "./lines";
import {
	maiaExtraSearchmoves,
	maiaUnscoredMoves,
	type ShapedSearchPlan,
	shapedSearchPlan,
} from "./maia-search";
import type { PolicyAcquisition, PolicyStage } from "./policy";
import type { PipelineSearcher, SearchCall } from "./search";
import type { PolicyAnswer, RecommendationInput } from "./types";

/** What the stages after analysis read from it. */
export interface AcquiredAnalysis {
	/** The frame the move is chosen from; the anchor stands in when the main search failed. */
	analysis: AnalysisResult | null;
	/** The Maia-shaped search that ran, if one did (its budget is the outcome's). */
	shaped: ShapedSearchPlan | null;
	/** The policy answer so far: held, or arrived in time to shape the search. */
	policy: PolicyAnswer | null;
}

export interface AnalysisStageDeps {
	searcher: PipelineSearcher;
	policy: PolicyStage;
	now: () => number;
}

/** Run the own-move search; `null` when the recommendation was cancelled on the way. */
export async function acquireAnalysis(
	deps: AnalysisStageDeps,
	input: RecommendationInput,
	own: OwnMoveContext,
	window: PreparationWindow,
	start: PolicyAcquisition
): Promise<AcquiredAnalysis | null> {
	const { snapshot } = input;
	const { budget, maia } = own;
	const call: SearchCall = {
		snapshot,
		targetElo: input.targetElo,
		maia,
		signal: input.signal,
		history: input.history,
	};
	const preInferred = start.held;
	const policyQuery = start.query;
	let policy: PolicyAnswer | null = preInferred;
	let shaped: ShapedSearchPlan | null = null;
	let anchor: AnalysisResult | null = null;
	if (maia && MAIA_SEARCH.shaped.enabled) {
		let known = preInferred ? input.policyAnswer?.knownTopMoves : undefined;
		const legal = new Set(legalMoves(snapshot.fen));
		if (!known?.some((uci) => legal.has(uci))) {
			const available = window.remaining(budget);
			if (available && available.movetimeMs >= 2 * SEARCH_BUDGET.minMovetimeMs) {
				const anchorMs = Math.min(
					MAIA_SEARCH.shaped.anchorMaxMs,
					available.movetimeMs * MAIA_SEARCH.shaped.anchorFraction
				);
				anchor = await deps.searcher.run(
					{
						...call,
						maia: true,
						shape: undefined,
						deadlineMs: Math.min(window.deadlineMs, deps.now() + anchorMs),
					},
					{
						...available,
						movetimeMs: anchorMs,
						multiPv: Math.min(SEARCH_BUDGET.ponderMultiPv, available.multiPv),
					}
				);
				if (anchor?.final.complete)
					known = usableLines(anchor.final.lines).flatMap((line) =>
						line.pvUci[0] ? [line.pvUci[0]] : []
					);
			}
		}
		if (!policy && policyQuery)
			policy = await deps.policy.await(
				policyQuery,
				input.signal,
				Math.min(
					MAIA_SEARCH.shaped.policyFirstMs,
					Math.max(0, window.deadlineMs - policyQuery.issuedAt)
				)
			);
		if (input.signal?.aborted) return null;
		const available = window.remaining(budget);
		if (policy && available)
			shaped = shapedSearchPlan(policy.result, snapshot.fen, known, available, input.targetElo);
	}
	const search = window.remaining(shaped?.budget ?? budget);
	let analysis = search
		? await deps.searcher.analyse(
				{
					...call,
					shape: shaped ? { searchmoves: shaped.searchmoves, shaped: true } : undefined,
					deadlineMs: window.deadlineMs,
				},
				search
			)
		: null;
	if (
		!analysis ||
		usableLines(analysis.final.lines).length === 0 ||
		(!analysis.final.complete && anchor?.final.complete)
	)
		analysis = anchor ?? analysis;
	return { analysis, shaped, policy };
}

/** The candidate pool after any extra referee search, and the moves only that search scored. */
export interface CandidateLines {
	lines: EvalLine[];
	maiaExtra: string[];
}

/**
 * Score significant unsearched policy candidates only with time left after a broad search.
 * Shaped searches already covered their roots; incomplete extra frames are discarded.
 * `null` when the recommendation was cancelled during the extra search.
 */
export async function scoreExtraCandidates(
	searcher: PipelineSearcher,
	input: RecommendationInput,
	own: OwnMoveContext,
	window: PreparationWindow,
	acquired: AcquiredAnalysis,
	policyResult: PolicyResult | null
): Promise<CandidateLines | null> {
	const { snapshot } = input;
	const { analysis, shaped } = acquired;
	const { budget, maia } = own;
	let lines = usableLines(analysis?.final.lines ?? []);
	let maiaExtra: string[] = [];
	const extraBudget = window.remaining({ ...budget, movetimeMs: extraSearchMs(budget) });
	if (
		analysis &&
		policyResult &&
		maia &&
		!shaped &&
		!clockBoundSearch(own.myClockMs, budget) &&
		extraBudget &&
		extraBudget.movetimeMs >= SEARCH_BUDGET.minMovetimeMs
	) {
		const searchmoves = maiaExtraSearchmoves(maiaUnscoredMoves(policyResult, lines, snapshot.fen));
		if (searchmoves.length > 0) {
			const extra = await searcher.run(
				{
					snapshot,
					targetElo: input.targetElo,
					maia,
					signal: input.signal,
					history: input.history,
					shape: { searchmoves, shaped: false },
					deadlineMs: window.deadlineMs,
				},
				{ ...extraBudget, multiPv: searchmoves.length }
			);
			if (input.signal?.aborted) return null;
			if (extra && !extra.final.complete) {
				// Incomplete frames cannot provide comparable scores for extra candidates.
				log.debug("recommendation: extra referee frame incomplete, ignored", {
					depth: extra.final.depth,
					lines: extra.final.lines.length,
					searchmoves,
				});
			} else if (extra) {
				const merged = mergeLines(lines, usableLines(extra.final.lines));
				const main = new Set(lines.map((line) => line.pvUci[0]));
				maiaExtra = merged.flatMap((line) => {
					const uci = line.pvUci[0];
					return uci !== undefined && !main.has(uci) ? [uci] : [];
				});
				lines = merged;
			}
		}
	}
	return { lines, maiaExtra };
}
