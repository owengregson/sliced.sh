/**
 * The upper verification band's distinct-candidate / Gaussian comparison (also the explicit
 * offline baseline): `k` distinct proposals, each read with perception noise, the best kept.
 */

import { GENERATE_VERIFY as GV } from "@core/constants/generate-verify";
import type { Rng } from "@core/rng";
import { fmt } from "../format";
import { candidateCount, intuitionProb, verificationCp, verifySigmaFor } from "./params";
import type { GvCandidate, GvConsidered, GvInput, GvResult } from "./types";

/** Draw `k` distinct candidates without replacement, each in proportion to its Maia mass. */
function drawDistinct(pool: readonly GvCandidate[], k: number, rng: Rng): GvCandidate[] {
	const remaining = [...pool];
	const drawn: GvCandidate[] = [];
	while (drawn.length < k && remaining.length > 0) {
		const pick = rng.weighted(
			remaining,
			remaining.map((c) => c.p)
		);
		drawn.push(pick);
		remaining.splice(remaining.indexOf(pick), 1);
	}
	return drawn;
}

/**
 * Generate-and-verify over the survivors, or `null` when the path is disabled or fewer than two
 * survivors carry Maia mass (the caller runs the plain draw). Draw order from `rng`: the
 * intuition coin, then (unless intuition) the `k` jitter, the `k` weighted draws, and one normal
 * per candidate.
 */
export function distinctCandidateVerification(input: GvInput): GvResult | null {
	if (!(input.enabled ?? GV.enabled)) return null;
	const pool = input.survivors.filter((c) => c.p > 0);
	if (pool.length < GV.candidates.min) return null;
	const { E, rng } = input;
	const pIntuition = intuitionProb(E);
	const intuition = rng.chance(pIntuition);
	const k = intuition ? 1 : Math.min(candidateCount(E, rng), pool.length);
	const drawn = drawDistinct(pool, k, rng);
	const sigma = verifySigmaFor(E);
	const verifyDepth = input.shallowDepth ?? 0;
	const considered: GvConsidered[] = drawn.map((c) => {
		const verified = c.shallowCp !== undefined;
		const cp = verificationCp(c, E);
		const score = intuition ? cp : cp + rng.normal(0, sigma);
		return { uci: c.uci, p: c.p, cp, score, verified };
	});
	let best = considered[0];
	if (best === undefined) return null;
	for (const row of considered) if (row.score > best.score) best = row;

	const rationale: string[] = [];
	if (intuition) {
		rationale.push(
			`generate-verify: intuition — played on recognition alone (p=${fmt(pIntuition, 2)} at E, ${pool.length} survivors)`
		);
	} else {
		const unverified = considered.filter((row) => !row.verified).length;
		const frame =
			verifyDepth > 0 ? `verified at depth ${verifyDepth}` : "no shallow frame, deep scores stood in";
		rationale.push(
			`generate-verify: k=${k} of ${pool.length} survivors (pIntuition ${fmt(pIntuition, 2)}), ${frame}, σ=${fmt(sigma, 1)}${unverified > 0 ? `, ${unverified} unverified` : ""}`
		);
		for (const row of considered)
			rationale.push(
				`  ${row.uci} p=${fmt(row.p)} ${row.verified ? "shallow" : "deep"} ${fmt(row.cp, 0)} → ${fmt(row.score, 0)}${row === best ? " ✓" : ""}`
			);
	}
	return { uci: best.uci, k, intuition, verifyDepth, considered, rationale };
}
