/** The prior `selectMove` weighs candidates by (§7.2 step 8): supplied or heuristic, hybrid-boosted. */

import type { EvalLine } from "@typedefs/engine";
import { SELECTION_CONSTANTS as C } from "../constants";
import { heuristicPriorDetailed, type PriorTerm } from "../prior";
import type { SelectionContext } from "../types";

export interface ResolvedPriors {
	values: Map<string, number>;
	/** The multiplicative terms behind each value (heuristic rows, hybrid boost). */
	terms: Map<string, PriorTerm[]>;
}

/** `resolvePriors` with the per-line terms kept for the rationale. */
export function resolvePriorsDetailed(
	lines: readonly EvalLine[],
	ctx: SelectionContext,
	prior?: ReadonlyMap<string, number>
): ResolvedPriors {
	const heuristic = prior === undefined ? heuristicPriorDetailed(ctx.fen, lines, ctx) : null;
	const values = new Map<string, number>();
	const terms = new Map<string, PriorTerm[]>();
	for (const line of lines) {
		const uci = line.pvUci[0];
		if (uci === undefined) continue;
		const lineTerms: PriorTerm[] = [];
		let value: number;
		if (heuristic) {
			const b = heuristic.get(uci);
			value = b?.value ?? 1;
			lineTerms.push(...(b?.terms ?? []));
		} else {
			value = prior?.get(uci) ?? 1;
			if (prior?.has(uci)) lineTerms.push({ rule: "supplied", factor: value });
		}
		if (ctx.selectionMode === "hybrid" && uci === ctx.engineBestmove) {
			value *= C.hybridBestmovePrior;
			lineTerms.push({ rule: "hybrid-bestmove", factor: C.hybridBestmovePrior });
		}
		values.set(uci, value);
		terms.set(uci, lineTerms);
	}
	return { values, terms };
}

/**
 * The prior actually used (§7.2 step 8): the supplied map (default
 * `heuristicPrior`) × 2.0 for the engine's `bestmove` in hybrid mode.
 */
export function resolvePriors(
	lines: readonly EvalLine[],
	ctx: SelectionContext,
	prior?: ReadonlyMap<string, number>
): Map<string, number> {
	return resolvePriorsDetailed(lines, ctx, prior).values;
}
