/**
 * Game-level budget controller (Appendix D §3a.2): expected own moves
 * remaining, a skill-scaled reserve and the per-move allocation. Untimed games
 * (§8.4b item 1) bypass the clock budget and use the classical schedule.
 */

import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";
import { ratingPace } from "./rating-pace";
import type { Persona, TcClass } from "./types";

const B = TIMING_CONSTANTS.budget;

/** The subset of `Features` the controller reads (structural, so tests can pass partials). */
export interface BudgetInputs {
	tc: TcClass;
	base_s: number;
	base_eff: number;
	inc_s: number;
	clock_s: number;
	ply: number;
	non_pawn_pieces: number;
	pawns: number;
	budget_used_ratio: number;
	targetElo?: number;
}

/** A rolling horizon: a surviving rook ending must not expire after move 40 or 80. */
export function expectedMovesRemaining(nonPawnPieces: number, pawns: number, ply: number): number {
	return clamp(
		B.nRemBase +
			B.nRemPerPiece * Math.max(0, nonPawnPieces) +
			B.nRemPerPawn * Math.max(0, pawns) -
			(B.nRemPerMove * Math.min(B.openingHorizonPlies, Math.max(0, ply))) / 2,
		B.nRemMin,
		B.nRemMax
	);
}

/** Reserve grows with base time and discipline; even a novice retains a minimum buffer. */
export function reserveSec(baseSec: number, tau: number): number {
	return (
		(0.5 + 0.5 * clamp(tau, 0, 1)) * clamp(B.reserveFraction * baseSec, B.reserveMinS, B.reserveMaxS)
	);
}

/** Clock-free allocation: `base_eff / N0` — the schedule an untimed or budget-off player follows. */
export function scheduleAlloc(f: Pick<BudgetInputs, "base_eff">): number {
	return Math.max(B.allocMinS, f.base_eff / TIMING_CONSTANTS.features.expectedMovesN0);
}

/** Sustainable seconds per move, including increment once and keeping a recoverable reserve. */
export function budgetController(f: BudgetInputs, persona: Persona): number {
	if (f.tc === "untimed") return scheduleAlloc(f);
	const discipline =
		f.targetElo === undefined ? persona.tau : (ratingPace(f.targetElo).discipline + persona.tau) / 2;
	const horizon = expectedMovesRemaining(f.non_pawn_pieces, f.pawns, f.ply);
	const reserve = Math.min(reserveSec(f.base_s, discipline), Math.max(0, f.clock_s) * 0.35);
	const principal = Math.max(0, f.clock_s - reserve) / horizon;
	const early = Math.max(0, 1 - f.ply / B.overspendPlyHorizon);
	return Math.max(
		B.allocMinS,
		principal * (1 + B.overspendFactor * (1 - discipline) * early) +
			B.allocIncWeight * Math.max(0, f.inc_s)
	);
}
