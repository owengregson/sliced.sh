/**
 * tools/human-match/strength-audit/laws.ts — the move laws the cache-only audit compares: the
 * historical (HEAD) and Sep15 distinct-candidate verifiers reconstructed with seeded conditional
 * draws, and the exact independent-proposal counterfactuals.
 */

import { createRng } from "@core/rng";
import { sigmaFor } from "@core/strength/elo-map";
import { type GvCandidate, intuitionProb, verifySigmaFor } from "@core/strength/generate-verify";

export type Knots = ReadonlyArray<readonly [number, number]>;
export const HEAD_BREADTH: Knots = [
	[800, 2],
	[1400, 3],
	[2000, 4],
	[2500, 5],
	[2800, 5],
];
const HEAD_SIGMA: Knots = [
	[800, 60],
	[1400, 45],
	[2000, 30],
	[2500, 20],
	[2800, 20],
];

export function interpolate(E: number, knots: Knots): number {
	let previous = knots[0];
	if (previous === undefined) throw new Error("Empty knots");
	if (E <= previous[0]) return previous[1];
	for (const next of knots.slice(1)) {
		if (E <= next[0])
			return previous[1] + ((E - previous[0]) / (next[0] - previous[0])) * (next[1] - previous[1]);
		previous = next;
	}
	return previous[1];
}

export function prior(pool: readonly GvCandidate[]): Map<string, number> {
	const total = pool.reduce((sum, c) => sum + c.p, 0);
	if (!(total > 0)) throw new Error("No probability mass");
	return new Map(pool.map((c) => [c.uci, c.p / total]));
}

/** Exact intuition component + seeded conditional comparison draws. No production overrides. */
export function distinctDistribution(
	pool: readonly GvCandidate[],
	E: number,
	version: "head" | "sep15",
	seed: string,
	samples: number
): Map<string, number> {
	const p = prior(pool);
	const I =
		version === "head"
			? interpolate(E, [
					[800, 0.55],
					[2500, 0.1],
				])
			: intuitionProb(E);
	const base = version === "head" ? Math.round(interpolate(E, HEAD_BREADTH)) : 2;
	const sigma =
		version === "head" ? Math.max(sigmaFor(E), interpolate(E, HEAD_SIGMA)) : verifySigmaFor(E);
	const q = new Map([...p].map(([uci, probability]) => [uci, I * probability]));
	const rng = createRng(seed);
	for (let n = 0; n < samples; n++) {
		const k = Math.min(pool.length, Math.max(2, Math.min(8, base + rng.int(-1, 1))));
		const remaining = [...pool];
		const drawn: GvCandidate[] = [];
		for (let i = 0; i < k; i++) {
			const pick = rng.weighted(
				remaining,
				remaining.map((c) => c.p)
			);
			drawn.push(pick);
			remaining.splice(remaining.indexOf(pick), 1);
		}
		let winner = "";
		let maximum = -Infinity;
		for (const candidate of drawn) {
			const score = (candidate.shallowCp ?? candidate.deepCp) + rng.normal(0, sigma);
			if (score > maximum) {
				maximum = score;
				winner = candidate.uci;
			}
		}
		if (!winner) throw new Error("No winner");
		q.set(winner, (q.get(winner) ?? 0) + (1 - I) / samples);
	}
	return q;
}

/**
 * Offline counterfactual only. Repeated proposals use original p, not the incumbent law.
 * Unscored pairs keep the incumbent; equal finite scores are a fair comparison.
 * Mix the final chain with the same Sep15 intuition; only proposal count is varied.
 */
export function independentDistribution(
	pool: readonly GvCandidate[],
	E: number,
	counts: readonly number[]
): Map<string, number> {
	const p = prior(pool);
	const I = intuitionProb(E);
	const sigma = verifySigmaFor(E);
	const result = new Map([...p].map(([uci, probability]) => [uci, I * probability]));
	for (const count of counts) {
		let current = new Map(p);
		for (let step = 1; step < count; step++) {
			const next = new Map(pool.map((c) => [c.uci, 0]));
			for (const incumbent of pool)
				for (const proposal of pool) {
					const mass = (current.get(incumbent.uci) ?? 0) * (p.get(proposal.uci) ?? 0);
					const comparable = Number.isFinite(incumbent.shallowCp) && Number.isFinite(proposal.shallowCp);
					const accept = comparable
						? 1 / (1 + Math.exp(((incumbent.shallowCp ?? 0) - (proposal.shallowCp ?? 0)) / sigma))
						: 0;
					next.set(incumbent.uci, (next.get(incumbent.uci) ?? 0) + mass * (1 - accept));
					next.set(proposal.uci, (next.get(proposal.uci) ?? 0) + mass * accept);
				}
			current = next;
		}
		for (const [uci, probability] of current)
			result.set(uci, (result.get(uci) ?? 0) + ((1 - I) * probability) / counts.length);
	}
	return result;
}
