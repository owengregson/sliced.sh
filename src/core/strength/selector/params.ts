/** The rating curves `selectMove` samples with: σ, τ, G, β and the rails' firing probabilities. */

import type { Phase } from "@core/chess/phase";
import { MAIA } from "@core/constants/maia";
import { clamp } from "@core/util/clamp";
import { SELECTION_CONSTANTS as C } from "../constants";
import { betaFor, eloRamp, gapFor, sigmaFor, tauFor } from "../elo-map";
import type { SelectionState } from "../types";

/**
 * §7.2 step 5 / H9: the probability a searched mate-in-≤ `mateInMax` is played at `E` — 1 from
 * `mateAlwaysElo`, else `mateProbBase + mateProbBase·(E − mateProbEloFloor)/mateProbEloSpan`
 * clamped to [0, 1] (0.5 at 800, 1 at 1400).
 */
export function mateRampProbability(E: number): number {
	const NP = C.neverPlay;
	if (E >= NP.mateAlwaysElo) return 1;
	return clamp(
		NP.mateProbBase + (NP.mateProbBase * (E - NP.mateProbEloFloor)) / NP.mateProbEloSpan,
		0,
		1
	);
}

/** H1: the probability the hang rail fires at the Maia rating `E` — 0 below `offElo`, 1 from `fullElo`. */
export function hangRailProbability(E: number): number {
	return eloRamp(E, MAIA.hangRail.offElo, 0, MAIA.hangRail.fullElo, 1);
}

/**
 * H12: the probability an adverse swing tilts the player at the Maia rating `E` — `probAtFloor`
 * at or below `probFullElo`, falling linearly to 0 at `probFloorElo`.
 */
export function tiltProbability(E: number): number {
	const T = MAIA.tilt;
	return T.probAtFloor * clamp((T.probFloorElo - E) / (T.probFloorElo - T.probFullElo), 0, 1);
}

export interface SelectionParams {
	tau: number;
	sigma: number;
	gap: number;
	beta: number;
	/** True when the 12-consecutive-top-1 τ×1.3 term is active. */
	streak: boolean;
	/** Appendix E §3.5 endgame τ multiplier (1 outside endgames / inside the 1200–1800 band). */
	endgameTau: number;
}

/** Appendix E §3.5: τ ×1.5 in endgames below 1200, ×0.7 from 1800. */
export function endgameTauFor(E: number, phase: Phase | undefined): number {
	if (phase !== "endgame") return 1;
	if (E < C.endgame.weakElo) return C.endgame.weakTau;
	if (E >= C.endgame.strongElo) return C.endgame.strongTau;
	return 1;
}

/**
 * σ, τ (with the streak and endgame terms), G and β for `E`, the current state
 * and phase (§7.2 steps 3 and 7; Appendix E §3.5).
 */
export function selectionParams(
	E: number,
	state: Pick<SelectionState, "top1Streak">,
	phase?: Phase,
	tauScale = 1
): SelectionParams {
	const streak = state.top1Streak >= C.tau.streakLength;
	const endgameTau = endgameTauFor(E, phase);
	return {
		tau: tauFor(E) * (streak ? C.tau.streakMultiplier : 1) * endgameTau * tauScale,
		sigma: sigmaFor(E),
		gap: gapFor(E),
		beta: betaFor(E),
		streak,
		endgameTau,
	};
}
