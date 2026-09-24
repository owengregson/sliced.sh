/**
 * Ordinary-range recognition verification: two independent Maia proposals and a logistic
 * comparison on the shallow evidence, with its exact law for the meters.
 */

import { GENERATE_VERIFY as GV } from "@core/constants/generate-verify";
import { fmt } from "../format";
import { intuitionProb, verifySigmaFor } from "./params";
import type { GvCandidate, GvInput, GvResult } from "./types";

/** Positive finite policy mass; duplicate roots do not get extra recognition tickets. */
function recognitionPool(survivors: readonly GvCandidate[]): GvCandidate[] {
	const byUci = new Map<string, GvCandidate>();
	for (const c of survivors) {
		if (!Number.isFinite(c.p) || c.p <= 0) continue;
		const previous = byUci.get(c.uci);
		if (previous === undefined || c.p > previous.p) byUci.set(c.uci, c);
	}
	return [...byUci.values()];
}

/** Missing shallow scores supply no comparison evidence, regardless of the deep scores. */
function comparisonProbability(a: GvCandidate, b: GvCandidate, E: number): number {
	if (
		a.shallowCp === undefined ||
		b.shallowCp === undefined ||
		!Number.isFinite(a.shallowCp) ||
		!Number.isFinite(b.shallowCp)
	)
		return 0.5;
	return 1 / (1 + Math.exp((b.shallowCp - a.shallowCp) / verifySigmaFor(E)));
}

/**
 * Exact law of two independent recognition proposals and a noisy shallow comparison, mixed
 * with the existing intuition share. Equal or missing evidence preserves Maia exactly.
 * Familiarity may propose the same move twice; unlike a distinct-candidate tournament this
 * does not force rare moves into consideration. q/p stays in [pIntuition, 2 - pIntuition].
 */
export function recognitionDistribution(
	input: Pick<GvInput, "survivors" | "E">
): Map<string, number> {
	const pool = recognitionPool(input.survivors);
	const total = pool.reduce((sum, c) => sum + c.p, 0);
	const q = new Map(pool.map((c) => [c.uci, c.p / total]));
	const compareShare = 1 - intuitionProb(input.E);
	for (let i = 0; i < pool.length; i++) {
		const a = pool[i];
		if (a === undefined) continue;
		for (let j = i + 1; j < pool.length; j++) {
			const b = pool[j];
			if (b === undefined) continue;
			const transfer =
				compareShare * 2 * (a.p / total) * (b.p / total) * (comparisonProbability(a, b, input.E) - 0.5);
			q.set(a.uci, (q.get(a.uci) ?? 0) + transfer);
			q.set(b.uci, (q.get(b.uci) ?? 0) - transfer);
		}
	}
	return q;
}

/** Two proposals, sampled with replacement; repeated recognition costs no extra comparison. */
export function recognitionVerification(input: GvInput): GvResult | null {
	const pool = recognitionPool(input.survivors);
	if (pool.length < GV.candidates.min) return null;
	const { E, rng } = input;
	const intuition = rng.chance(intuitionProb(E));
	const first = rng.weighted(
		pool,
		pool.map((c) => c.p)
	);
	const second = intuition
		? first
		: rng.weighted(
				pool,
				pool.map((c) => c.p)
			);
	const compared = !intuition && first.uci !== second.uci;
	const bothScored = Number.isFinite(first.shallowCp) && Number.isFinite(second.shallowCp);
	const pick =
		compared && bothScored && rng.chance(comparisonProbability(second, first, E)) ? second : first;
	const considered = (compared ? [first, second] : [first]).map((c) => ({
		uci: c.uci,
		p: c.p,
		cp: Number.isFinite(c.shallowCp) ? (c.shallowCp ?? 0) : 0,
		score: Number.isFinite(c.shallowCp) ? (c.shallowCp ?? 0) : 0,
		verified: Number.isFinite(c.shallowCp),
	}));
	const verifyDepth = input.shallowDepth ?? 0;
	const rationale = [
		intuition
			? `generate-verify: intuition — played on recognition alone (p=${fmt(intuitionProb(E), 2)} at E, ${pool.length} survivors)`
			: `generate-verify: recognition proposals ${considered.length} of ${pool.length}, ${compared && bothScored ? `compared at depth ${verifyDepth}` : "recognition retained; no comparable new evidence"}, σ=${fmt(verifySigmaFor(E), 1)}`,
	];
	return { uci: pick.uci, k: considered.length, intuition, verifyDepth, considered, rationale };
}
