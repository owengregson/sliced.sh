/** The Maia rails: Maia's mass over the scored set, the never-play exclusions and the loss cap. */

import { MAIA } from "@core/constants/maia";
import { maiaMaxCpLoss } from "@core/policy/maia-size";
import type { PolicyResult } from "@core/policy/types";
import { fmt } from "../format";
import { interpolateKnots } from "../knots";
import type { MaiaCandidate, MaiaDrawOptions, MaiaSurvivors } from "./types";

/** `MAIA.lossCap` by effective Elo: flat outside the knots, linear between. */
export function lossCapFor(E: number): number {
	return interpolateKnots(E, MAIA.lossCap, 1);
}

/** Maia's probability per UCI (the larger when a move is listed twice, which it never should be). */
export function policyProbabilities(policy: Pick<PolicyResult, "moves">): Map<string, number> {
	const prob = new Map<string, number>();
	for (const [uci, p] of policy.moves) prob.set(uci, Math.max(prob.get(uci) ?? 0, p));
	return prob;
}

/**
 * The first half of `drawMaiaMove`: Maia's mass over the scored set, the rails (mated, hangs,
 * `lossCapFor(E)`) and the masses the meters report. `null` when nothing scored carries
 * `p ≥ MAIA.minProb` (the base policy must decide). Every row it has to say goes to `rationale`.
 */
export function maiaSurvivors(
	candidates: readonly MaiaCandidate[],
	policy: PolicyResult,
	E: number,
	rationale: string[],
	options: Pick<MaiaDrawOptions, "scoredMassBefore"> = {}
): MaiaSurvivors | null {
	const prob = policyProbabilities(policy);
	let total = 0;
	for (const p of prob.values()) total += p;
	let scoredMass = 0;
	let extra = 0;
	for (const c of candidates) {
		scoredMass += prob.get(c.uci) ?? 0;
		if (c.extra) extra++;
	}
	const scoredMassBefore = options.scoredMassBefore ?? scoredMass;
	const unscoredMass = Math.max(0, total - scoredMassBefore);
	if (scoredMassBefore < MAIA.minScoredMass)
		rationale.push(
			`maia: engine's scored set covers ${fmt(scoredMassBefore)} of the model's mass (< ${MAIA.minScoredMass})`
		);

	const cap = lossCapFor(E);
	const cpCap = maiaMaxCpLoss(E);
	const survivors = candidates.filter(
		(c) => !c.mated && !c.hangs && c.lossRaw <= cap && (c.cpLoss ?? 0) <= cpCap
	);
	const excluded = candidates.length - survivors.length;
	let railedMass = 0;
	if (excluded > 0) {
		const kept = new Set(survivors.map((c) => c.uci));
		for (const c of candidates) if (!kept.has(c.uci)) railedMass += prob.get(c.uci) ?? 0;
		rationale.push(
			`maia never-play: ${excluded} line(s) excluded (loss cap ${fmt(cap, 2)} at E, mass ${fmt(railedMass)})`
		);
	}
	const pool: Array<readonly [string, number]> = survivors.map((c) => [c.uci, prob.get(c.uci) ?? 0]);
	if (!pool.some(([, p]) => p >= MAIA.minProb)) {
		rationale.push(`maia: no scored candidate at p ≥ ${MAIA.minProb}, base policy`);
		return null;
	}
	return {
		prob,
		survivors,
		pool,
		scored: candidates.length,
		extra,
		scoredMass,
		scoredMassBefore,
		unscoredMass,
		railedMass,
	};
}
