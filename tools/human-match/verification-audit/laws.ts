/**
 * tools/human-match/verification-audit/laws.ts — the move laws the audit compares against the
 * human move, and how one law is scored.
 */

import { createRng } from "@core/rng";
import {
	distinctCandidateVerification,
	type GvCandidate,
	intuitionProb,
} from "@core/strength/generate-verify";

/** Preserve the exact intuition component so Monte Carlo never invents zero tail probability. */
export function legacyDistribution(
	pool: GvCandidate[],
	E: number,
	seed: string,
	samples = 20000
): Map<string, number> {
	const total = pool.reduce((sum, c) => sum + c.p, 0);
	const intuitive = intuitionProb(E);
	const q = new Map(pool.map((c) => [c.uci, (intuitive * c.p) / total]));
	const rng = { ...createRng(seed), chance: () => false };
	for (let i = 0; i < samples; i++) {
		const result = distinctCandidateVerification({ survivors: pool, E, rng });
		if (result === null) return new Map(pool.map((c) => [c.uci, c.p / total]));
		q.set(result.uci, (q.get(result.uci) ?? 0) + (1 - intuitive) / samples);
	}
	return q;
}

export interface LawMetrics {
	nll: number | null;
	match: number;
	p: number;
	brier: number;
	confidence: number;
}

/** NLL, top-1 match, the human move's probability and the Brier score of one law. */
export function lawMetrics(q: ReadonlyMap<string, number>, human: string): LawMetrics {
	const p = q.get(human) ?? 0;
	let top = "";
	let confidence = 0;
	let brier = 1 - 2 * p;
	for (const [uci, value] of q) {
		brier += value * value;
		if (value > confidence) {
			top = uci;
			confidence = value;
		}
	}
	return { nll: p > 0 ? -Math.log(p) : null, match: top === human ? 1 : 0, p, brier, confidence };
}
