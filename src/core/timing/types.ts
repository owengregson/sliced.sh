/**
 * Move-timing model interfaces (Part I §8.3, normative). `TimingPlan`,
 * `TimingMode` and `TimingLogEntry` live in `@typedefs/timing` (shared across
 * contexts) and are re-exported here; everything else in the §8.3 surface is
 * declared in this file.
 */

import type { Rng } from "@core/rng";
import type { EvalLine } from "@typedefs/engine";
import type { Site, Square } from "@typedefs/game";
import type { PersonaId, Settings } from "@typedefs/settings";
import type {
	MoveWindowBudget,
	TimingLogEntry,
	TimingMode,
	TimingModelSource,
	TimingPlan,
} from "@typedefs/timing";

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
	/**
	 * §7.3 / Task 30: the opening book answered for this position. The feature's other half —
	 * "we are playing the engine's best move early" — is derived from the lines; this is the
	 * book half, which only the session knows.
	 */
	inBook?: boolean;
	inputMethod: "drag" | "click";
	autoQueen: boolean;
	/** Original opponent-position arrival, even when planning runs after asynchronous preparation. */
	nowMs: number;
}

export type ReplanReason =
	/** A plan whose deadline has passed is re-delivered: fold the wait into the think so the §8.6
	 * row reports the hold the page actually saw, not the floor `schedule` would fit it to. */
	| "withheld-then-released"
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

/**
 * The timing knobs the model runs on. Every leaf of `Settings["timing"]` except the speed one:
 * the user's `timing.baseSpeed` is a **speed** (higher = faster) and everything downstream —
 * `createMoveBudget`, the head's compensation, the cap — multiplies a **duration**, so the
 * reciprocal is taken once, at `timingSettingsFor` (`src/service/game-session/presets.ts`), and
 * what the model sees is named for what it is. Nothing here reads a "speed" that means slowness
 * (owner, 2026-09-15).
 */
export interface TimingSettings extends Omit<Settings["timing"], "baseSpeed"> {
	/**
	 * Duration multiplier on the human wait: `per-time-control gain / baseSpeed` (2026-09-15: the
	 * preset knob that stood beside the gain went with the timing presets).
	 * Above 1 the move takes longer, below 1 it takes less.
	 */
	moveTimeScale: number;
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
	/** `thinkMs` of every plan this game. */
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
	/** Learned clock labels already include perception and execution. Never add the hand again. */
	includesExecution?: boolean;
	mode: TimingMode;
	why: string[];
	/** Per-term contributions (`β_i f_i`) for the debug view / timing log. */
	terms?: Array<[string, number]>;
}

export interface TimingPreparation {
	/** May use the already-running search window; never extends the search deadline. */
	budgetMs?: number;
	signal?: AbortSignal;
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
	median(f: Features, persona: Persona, state: GameTimingState, allocSec: number): number;
	/** Expected sampled seconds before outer clock budgeting, when available. */
	mean?(f: Features, persona: Persona, state: GameTimingState, allocSec: number): number;
	/** Issue asynchronous inference for `ctx` ahead of `sample` (ChessMimic); resolves when cached. */
	prepare?(ctx: TimingContext, options?: TimingPreparation): Promise<void>;
	/** Source actually available for this position, including fallback failures. */
	diagnostics?(fen: string): TimingModelSource;
	/** Drop any per-game cache (called from `startGame`). */
	reset?(): void;
}

export interface GameMeta {
	targetElo: number;
	profile: PersonaProfile;
	baseSec: number;
	incSec: number;
	site: Site;
	gameId: string;
}
