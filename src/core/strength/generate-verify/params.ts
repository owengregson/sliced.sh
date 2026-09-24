/** The rating curves generate-and-verify runs on: `k(E)`, `pIntuition(E)` and the verify noise. */

import { GENERATE_VERIFY as GV } from "@core/constants/generate-verify";
import { upperVerificationProgress } from "@core/policy/maia-size";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { eloRamp, sigmaFor } from "../elo-map";
import { interpolateKnots } from "../knots";
import type { GvCandidate } from "./types";

/** The un-jittered `k(E)`: the `GENERATE_VERIFY.candidates` knots interpolated and rounded. */
export function candidateBase(E: number): number {
	return Math.round(interpolateKnots(E, GV.candidates.knots, 0));
}

/** `k(E)` for one move: `candidateBase(E) ± jitter`, clamped to `[min, max]`. Consumes one draw. */
export function candidateCount(E: number, rng: Rng): number {
	const { jitter, min, max } = GV.candidates;
	return clamp(candidateBase(E) + rng.int(-jitter, jitter), min, max);
}

/** `pIntuition(E)`: the probability the move is played on recognition alone. */
export function intuitionProb(E: number): number {
	const { loElo, loProb, hiElo, hiProb } = GV.intuition;
	const ordinary = eloRamp(E, loElo, loProb, hiElo, hiProb);
	return ordinary + upperVerificationProgress(E) * (GV.intuition.upperProb - ordinary);
}

/** Above 2800, progressively include the same bounded search's deeper evidence. */
export function verificationCp(candidate: GvCandidate, E: number): number {
	const shallow = candidate.shallowCp ?? candidate.deepCp;
	return shallow + upperVerificationProgress(E) * (candidate.deepCp - shallow);
}

/**
 * The perception noise on the verified (shallow) scores: `max(sigmaFor(E), floor(E))` with the
 * `GENERATE_VERIFY.verifySigmaFloorCp` knots — `sigmaFor` was calibrated against deep scores, and
 * a score read at the human depth carries the shallow frame's own error on top (HvS §5.4).
 */
export function verifySigmaFor(E: number): number {
	return Math.max(sigmaFor(E), interpolateKnots(E, GV.verifySigmaFloorCp, 0));
}
