/**
 * Maia candidate safeguards, weighted draws and policy-fidelity accounting. The public entry:
 * the rails live in `maia-select/rails.ts`, the tie-band terms in `maia-select/band.ts` and the
 * pick's record in `maia-select/record.ts`.
 */

import { MAIA } from "@core/constants/maia";
import { klDivergence, temperedWeights } from "@core/policy/maia-policy";
import type { PolicyResult } from "@core/policy/types";
import type { Rng } from "@core/rng";
import { applyPractical, applyTieBreak, tieBandOf } from "./maia-select/band";
import { maiaSurvivors } from "./maia-select/rails";
import { maiaDrawRecord } from "./maia-select/record";
import type { MaiaCandidate, MaiaDraw, MaiaDrawOptions, MaiaSurvivors } from "./maia-select/types";

export { tieBandOf } from "./maia-select/band";
export { lossCapFor, maiaSurvivors, policyProbabilities } from "./maia-select/rails";
export { maiaDrawRecord } from "./maia-select/record";
export type {
	MaiaCandidate,
	MaiaDraw,
	MaiaDrawOptions,
	MaiaPractical,
	MaiaSurvivors,
	MaiaTieBreak,
} from "./maia-select/types";

/**
 * The second half of `drawMaiaMove`: one weighted draw from Maia's distribution over the
 * survivors at `MAIA.temperature`, with the H11 tie-break and the H13 practical-difficulty term
 * applied inside the tie band, and the pick's record.
 */
export function drawMaiaFromSurvivors(
	set: MaiaSurvivors,
	policy: PolicyResult,
	E: number,
	rng: Rng,
	rationale: string[],
	options: Pick<MaiaDrawOptions, "tieBreak" | "practical" | "simplification"> = {}
): MaiaDraw {
	const weights = temperedWeights(set.pool, MAIA.temperature, MAIA.minProb);
	const band = tieBandOf(weights);
	const tieBand = applyTieBreak(weights, band, options.tieBreak);
	if (tieBand > 0)
		rationale.push(
			`maia tie-break: ${tieBand} near-equal survivors (≥ ${MAIA.tieBandRatio}× top weight), technique prior applied`
		);
	const practical = applyPractical(weights, band, options.practical);
	if (practical.moved > 0)
		rationale.push(
			`maia practical: ${practical.moved} near-equal survivors weighted by 1 + trickiness (${practical.rows.join(", ")})`
		);
	for (const [uci, factor] of options.simplification ?? []) {
		if (weights.has(uci)) weights.set(uci, (weights.get(uci) ?? 0) * factor);
	}
	const items = [...weights.keys()];
	const uci = rng.weighted(
		items,
		items.map((u) => weights.get(u) ?? 0)
	);
	return maiaDrawRecord(
		set,
		policy,
		E,
		uci,
		{ klFromMaia: klDivergence(weights, set.prob), tieBand, practicalBand: practical.moved },
		rationale
	);
}

/**
 * Draw one of `candidates` from Maia's distribution at the rating `E` (already the one the query
 * was issued at: pressure, slider, context and ambiguity folded in by `maiaSelfElo`), or `null`
 * when the base policy must decide this move (nothing scored carries `p ≥ MAIA.minProb`, or the
 * rails emptied the set). Every outcome leaves its reason in `rationale`.
 */
export function drawMaiaMove(
	candidates: readonly MaiaCandidate[],
	policy: PolicyResult,
	E: number,
	rng: Rng,
	rationale: string[],
	options: MaiaDrawOptions = {}
): MaiaDraw | null {
	const set = maiaSurvivors(candidates, policy, E, rationale, options);
	if (set === null) return null;
	return drawMaiaFromSurvivors(set, policy, E, rng, rationale, options);
}
