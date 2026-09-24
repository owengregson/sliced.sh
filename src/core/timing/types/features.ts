/** The Appendix D §2 feature vector. */

import type { Square } from "@typedefs/game";
import type { TcClass } from "./context";

export type PhaseName = "opening" | "middlegame" | "endgame";

/**
 * The 25 features of Appendix D §2 (numbers 1–25) plus the derived scalars the
 * heads read directly (`clock_s`, `ln_n_reasonable`, `phase_mid`, `eval_cp`,
 * `premove_eligible`, piece counts for the budget controller).
 */
export interface Features {
	/** Unclipped requested rating for the continuous timing policy. */
	targetElo?: number;
	/** Distinguishes an observed single choice from missing engine analysis. */
	analysis_lines?: number;
	threat_reply?: number;
	// 1–8
	elo_z: number;
	tc: TcClass;
	log_base_eff: number;
	inc_s: number;
	log_clock: number;
	pressure: number;
	clock_ratio: number;
	ply: number;
	ply_sq: number;
	// 9
	phase: PhaseName;
	phase_c: number;
	phase_mid: number;
	phase_end: number;
	// 10–17
	in_book: number;
	n_reasonable: number;
	ln_n_reasonable: number;
	decisiveness: number;
	chosen_rank: number;
	chosen_gap: number;
	eval_abs: number;
	eval_sign: number;
	swing_bad: number;
	swing_good: number;
	ponder_hit: number;
	// 18 move_type flags
	is_capture: number;
	is_recapture: number;
	is_check: number;
	gives_mate: number;
	is_promotion: number;
	is_castle: number;
	is_only_legal: number;
	is_forced: number;
	// 19–25
	n_legal: number;
	dist: number;
	opp_pace: number;
	opp_last: number;
	/** §8.4b item 5: the opponent replies at a near-constant sub-second pace (a bot). */
	opp_is_bot: number;
	my_pace_resid: number;
	budget_used_ratio: number;
	material_imb: number;
	// derived
	/** My clock in seconds (the virtual classical clock when untimed). */
	clock_s: number;
	/** Eval after the chosen move, our POV, cp (mates mapped, clamped). */
	eval_cp: number;
	premove_eligible: number;
	base_eff: number;
	base_s: number;
	non_pawn_pieces: number;
	pawns: number;
	/** Chebyshev distance is `dist`; the from/to squares feed the motor model. */
	from: Square;
	to: Square;
}
