/** Result assembly: the `Recommendation` and the outcome the session acts on. */

import type { AnalysisResult } from "@core/engine/types";
import type { TimingPlan } from "@core/timing/types";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, Recommendation } from "@typedefs/game";

import type { SearchBudget } from "./budget";
import type { PolicyAnswer, RecommendationInput, RecommendationOutcome } from "./types";

export interface AssemblyInput {
	chosen: ChosenMove;
	lines: EvalLine[];
	analysis: AnalysisResult | null;
	plan: TimingPlan;
	policy: PolicyAnswer | null;
	/** The budget the move search ran at (the shaped one when Maia shaped it). */
	budget: SearchBudget;
}

export function assembleOutcome(
	input: RecommendationInput,
	parts: AssemblyInput
): RecommendationOutcome {
	const { chosen, lines, analysis, plan, policy } = parts;
	// Use position complexity from timing features; MultiPV count depends on the search budget
	// and would create a spurious relationship between measured complexity and move time.
	const nReasonable = Math.max(1, plan.features.n_reasonable ?? 1);

	const best = lines[0];
	const rec: Recommendation = {
		chosen,
		lines,
		eval: best?.score ?? { cp: 0 },
		depth: analysis?.final.depth ?? 0,
		nps: analysis?.final.nps ?? 0,
		plan,
		computedAt: input.nowMs,
		fen: input.snapshot.fen,
	};
	const wdl = best?.wdl;
	if (wdl) rec.wdl = wdl;
	if (policy) {
		rec.maia = {
			size: policy.result.size,
			wdl: policy.result.wdl,
			historyPlies: policy.historyPlies,
			selfElo: policy.selfElo,
		};
		if (policy.result.ms !== undefined) rec.maia.ms = policy.result.ms;
		if (chosen.maiaProb !== undefined) rec.maia.p = chosen.maiaProb;
		if (chosen.maiaMeters !== undefined) rec.maia.meters = chosen.maiaMeters;
	}
	return {
		rec,
		nReasonable,
		fromBook: chosen.source === "book",
		budget: parts.budget,
		analysis,
	};
}
