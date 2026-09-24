/**
 * Recognition-preserving Maia verification (2026-09-16).
 *
 * Through the ordinary range (effective Elo <= 2800), recognition proposes twice independently
 * from Maia; a logistic comparison uses only available shallow evidence. Equal or missing
 * evidence leaves the population distribution unchanged. The exact distribution is available
 * for fidelity accounting without Monte Carlo in the service worker.
 *
 * The existing distinct-candidate / Gaussian comparison is retained in the upper verification
 * band and as an explicit offline baseline. It must not be described as running Maia unchanged:
 * choosing a noisy argmax from distinct proposals can amplify unlikely moves even at equal cp.
 * See docs/research/maia-recognition-verification-2026-09-16.md for evidence and limitations.
 */

import { GENERATE_VERIFY as GV } from "@core/constants/generate-verify";
import { upperVerificationProgress } from "@core/policy/maia-size";
import type { Rng } from "@core/rng";
import { distinctCandidateVerification } from "./generate-verify/distinct";
import { recognitionDistribution, recognitionVerification } from "./generate-verify/recognition";
import type { GvInput, GvResult } from "./generate-verify/types";

export { distinctCandidateVerification } from "./generate-verify/distinct";
export { gvKl } from "./generate-verify/fidelity";
export {
	candidateBase,
	candidateCount,
	intuitionProb,
	verificationCp,
	verifySigmaFor,
} from "./generate-verify/params";
export { recognitionDistribution } from "./generate-verify/recognition";
export type { GvCandidate, GvConsidered, GvInput, GvResult } from "./generate-verify/types";

/** The upper-band path is preserved; ordinary verification keeps recognition mass. */
export function generateAndVerify(input: GvInput): GvResult | null {
	if (!(input.enabled ?? GV.enabled)) return null;
	return upperVerificationProgress(input.E) > 0
		? distinctCandidateVerification(input)
		: recognitionVerification(input);
}

/**
 * The exact ordinary-range distribution, or upper-range empirical law over `samples` runs, that the meters
 * and the harness (§8.2) read. When the path would return `null` the plain draw's distribution
 * (Maia's mass renormalised over the survivors) is returned instead, since that is what would
 * be played. Sums to 1.
 */
export function drawDistribution(
	input: Omit<GvInput, "rng">,
	samples: number,
	rng: Rng
): Map<string, number> {
	if ((input.enabled ?? GV.enabled) && upperVerificationProgress(input.E) === 0)
		return recognitionDistribution(input);
	const q = new Map<string, number>();
	const add = (uci: string, mass: number) => q.set(uci, (q.get(uci) ?? 0) + mass);
	let landed = 0;
	for (let i = 0; i < samples; i++) {
		const result = generateAndVerify({ ...input, rng });
		if (result === null) break;
		add(result.uci, 1);
		landed++;
	}
	if (landed === samples && samples > 0) {
		for (const [uci, n] of q) q.set(uci, n / samples);
		return q;
	}
	q.clear();
	let total = 0;
	for (const c of input.survivors) if (c.p > 0) total += c.p;
	for (const c of input.survivors) if (c.p > 0 && total > 0) add(c.uci, c.p / total);
	return q;
}
