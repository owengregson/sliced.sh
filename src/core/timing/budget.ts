/**
 * Game-level budget controller (Appendix D §3a.2): expected own moves
 * remaining, a skill-scaled reserve and the per-move allocation. Untimed games
 * (§8.4b item 1) bypass the clock budget and use the classical schedule.
 */

import { clamp } from "@core/util/clamp";
import { TIMING_CONSTANTS } from "./constants";
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
}

/** `N_rem = clamp(22 + 0.9·pieces + 0.5·pawns − 0.25·(ply/2), 10, 45)`. */
export function expectedMovesRemaining(nonPawnPieces: number, pawns: number, ply: number): number {
	return clamp(
		B.nRemBase + B.nRemPerPiece * nonPawnPieces + B.nRemPerPawn * pawns - B.nRemPerMove * (ply / 2),
		B.nRemMin,
		B.nRemMax
	);
}

/** `reserve = τ · clamp(0.06·base, 2, 20)` seconds. */
export function reserveSec(baseSec: number, tau: number): number {
	return tau * clamp(B.reserveFraction * baseSec, B.reserveMinS, B.reserveMaxS);
}

/** Clock-free allocation: `base_eff / N0` — the schedule an untimed or budget-off player follows. */
export function scheduleAlloc(f: Pick<BudgetInputs, "base_eff">): number {
	return Math.max(B.allocMinS, f.base_eff / TIMING_CONSTANTS.features.expectedMovesN0);
}

/** Per-move allocation in seconds (Appendix D §3a.2). */
export function budgetController(f: BudgetInputs, persona: Persona): number {
	if (f.tc === "untimed") return scheduleAlloc(f);
	const nRem = expectedMovesRemaining(f.non_pawn_pieces, f.pawns, f.ply);
	const reserve = reserveSec(f.base_s, persona.tau);
	let alloc = Math.max(B.allocMinS, (f.clock_s - reserve) / nRem + B.allocIncWeight * f.inc_s);
	const early = Math.max(0, 1 - f.ply / B.overspendPlyHorizon);
	alloc *= 1 + B.overspendFactor * (1 - persona.tau) * early;
	alloc *= Math.exp(B.aheadOfScheduleExp * f.budget_used_ratio);
	return Math.max(B.allocMinS, alloc);
}
