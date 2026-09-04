/**
 * Per-game persona latents (Appendix D §4, as amended by §8.4b item 4): a pure
 * function of the per-game seed, the profile and the target Elo. There is no
 * `session_mu`, no per-user drift and no cross-game state.
 */

import { createRng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";
import { beta, uniform } from "./distributions";
import { eloZ } from "./features";
import type { Persona, PersonaProfile } from "./types";

const P = TIMING_CONSTANTS.persona;

/** Beta(a, b) parameters for a given mean and standard deviation. */
function betaParams(mean: number, sd: number): [number, number] {
	const m = clamp(mean, P.tauMeanClamp[0], P.tauMeanClamp[1]);
	const k = Math.max(2, (m * (1 - m)) / (sd * sd) - 1);
	return [m * k, (1 - m) * k];
}

export function samplePersona(
	seed: number | string,
	profile: PersonaProfile,
	targetElo: number
): Persona {
	const rng = createRng(typeof seed === "string" ? `persona:${seed}` : seed);
	const offsets = P.profiles[profile];
	const e = eloZ(targetElo);
	const s_game = rng.normal(offsets.speed, P.sGameSigma);
	const iota = clamp(beta(rng, P.iotaBeta[0], P.iotaBeta[1]) + offsets.iota, 0, 1);
	const pi_p = rng.normal(offsets.premove, P.piSigma);
	const [a, b] = betaParams(P.tauMean + P.tauEloSlope * e, P.tauSd);
	const tau = beta(rng, a, b);
	const rho_mirror = uniform(rng, P.mirrorRange[0], P.mirrorRange[1]);
	const motor_k = Math.max(P.motorKMin, rng.normal(P.motorKMean, P.motorKSd));
	return { s_game, iota, pi_p, tau, rho_mirror, motor_k };
}

/** The latents as a flat record (for `SESSION_KEYS.personaByGame` and the debug view). */
export function personaToRecord(p: Persona): Record<string, number> {
	return {
		s_game: p.s_game,
		iota: p.iota,
		pi_p: p.pi_p,
		tau: p.tau,
		rho_mirror: p.rho_mirror,
		motor_k: p.motor_k,
	};
}
