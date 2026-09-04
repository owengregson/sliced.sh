/**
 * Move-timing model interfaces (Part I §8.3, normative). `TimingPlan`,
 * `TimingMode` and `TimingLogEntry` live in `@typedefs/timing` (shared across
 * contexts) and are re-exported here; everything else in the §8.3 surface is
 * declared in this file.
 */

import type { Rng } from "@core/rng";
import type { EvalLine } from "@typedefs/engine";
import type { Site, Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import type { MoveWindowBudget, TimingLogEntry, TimingMode, TimingPlan } from "@typedefs/timing";

export type { MoveWindowBudget, TimingLogEntry, TimingMode, TimingPlan };

/** Lichess convention on `base + 40·inc`; `"untimed"` when there is no clock (§8.4b item 1). */
export type TcClass = "bullet" | "blitz" | "rapid" | "classical" | "untimed";

/** The persona profile is the user's `Settings.strength.persona` (Appendix D §4 table in constants). */
export type PersonaProfile = PersonaId;

export interface TimingContext {
	fen: string;
	ply: number;
	/** UCI moves played so far this game (the last one is the opponent's reply). */
	moves: string[];
	myColor: "w" | "b";
	chosenMove: string;
	/** MultiPV lines at the feature depth, side-to-move POV. */
	lines: EvalLine[];
	evalBeforeOppMove: number | null;
	expectedOppReply: string | null;
	myClockMs: number;
	oppClockMs: number;
	/** `0` and `0` together mean an untimed game. */
	baseSec: number;
	incSec: number;
	oppThinkMsHistory: number[];
	myThinkMsHistory: number[];
	site: Site;
	targetElo: number;
	profile: PersonaProfile;
	engineReady: boolean;
	inputMethod: "drag" | "click";
	autoQueen: boolean;
	nowMs: number;
}

export type ReplanReason =
	| "engine-not-ready"
	| "engine-changed"
	| "clock-jump"
	| "opponent-moved"
	| "blur"
	| "manual-now"
	| "emergency";

export type PhaseName = "opening" | "middlegame" | "endgame";

/**
 * The 25 features of Appendix D §2 (numbers 1–25) plus the derived scalars the
 * heads read directly (`clock_s`, `ln_n_reasonable`, `phase_mid`, `eval_cp`,
 * `premove_eligible`, piece counts for the budget controller).
 */
export interface Features {
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

/** Per-game latent persona (Appendix D §4), sampled once per game from the per-game seed. */
export interface Persona {
	/** Log speed multiplier. */
	s_game: number;
	/** Impulsiveness ∈ [0,1]. */
	iota: number;
	/** Premove tendency (logit units). */
	pi_p: number;
	/** Time-management skill ∈ [0,1]. */
	tau: number;
	/** Opponent-tempo coupling (`β_mirror`). */
	rho_mirror: number;
	/** Multiplies hover/drag. */
	motor_k: number;
}

/** Settings-derived knobs the heads read (§8.3 `Settings["timing"]`). */
export interface TimingKnobs {
	/** Multiplies σ (`varianceScale`). */
	sigmaScale: number;
	/** Added to the premove logit (`premoveTendency`). */
	piOffset: number;
	/** Multiplies `λ0` (`longThinkFrequency`). */
	lambdaScale: number;
}

/** Everything reset by `startGame()` (§8.2 "state", §8.4b item 4). */
export interface GameTimingState {
	gameId: string;
	/** Position being planned (set by `planMove`; the ChessMimic head keys its cache on it). */
	fen: string;
	ply: number;
	/** AR(1) residual ε_t. */
	eps: number;
	/** When set, the head must not advance ε_t (re-plan with the same residual). */
	freezeEps: boolean;
	tilt: number;
	oppThinkMs: number[];
	myThinkMs: number[];
	/** `thinkMs` of every plan this game (the CV guard reads it). */
	plannedMs: number[];
	/** `ln t_actual − ln t_model_body` per observed move (`my_pace_resid`). */
	paceResiduals: number[];
	/** Eval (our POV) after our previous move; drives the tilt trigger. */
	lastEvalOurPov: number | null;
	lastPlan: TimingPlan | null;
	knobs: TimingKnobs;
}

export interface HeadSample {
	tSec: number;
	mode: TimingMode;
	why: string[];
	/** Per-term contributions (`β_i f_i`) for the debug view / timing log. */
	terms?: Array<[string, number]>;
}

export interface DistributionHead {
	readonly id: "v1-parametric" | "chessmimic";
	sample(
		f: Features,
		persona: Persona,
		state: GameTimingState,
		rng: Rng,
		allocSec: number
	): HeadSample;
	/** Model median think time for the position without residual/mirroring (bot-pace floor). */
	median(f: Features, persona: Persona, allocSec: number): number;
	/** Issue asynchronous inference for `ctx` ahead of `sample` (ChessMimic); resolves when cached. */
	prepare?(ctx: TimingContext): Promise<void>;
}

export interface GameMeta {
	targetElo: number;
	profile: PersonaProfile;
	baseSec: number;
	incSec: number;
	site: Site;
	gameId: string;
}
