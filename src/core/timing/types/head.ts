/** The per-game persona and state, and the `DistributionHead` strategy both heads implement. */

import type { Rng } from "@core/rng";
import type { TimingMode, TimingModelSource, TimingPlan } from "@typedefs/timing";
import type { TimingContext } from "./context";
import type { Features } from "./features";

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
	/** Move being planned (set by `planMove`): the ChessMimic head's row for it, when inferred. */
	move?: string;
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
	/** The learned distribution already accounts for the opponent's remaining clock. */
	opponentClockConditioned?: boolean;
	mode: TimingMode;
	why: string[];
	/** Per-term contributions (`β_i f_i`) for the debug view / timing log. */
	terms?: Array<[string, number]>;
}

export interface TimingPreparation {
	/** Bounded inference window from preparation start; never extends the engine search. */
	budgetMs?: number;
	signal?: AbortSignal;
	/**
	 * Moves likely to be chosen (book, policy top-k, a pondered reply): ChessMimic infers one row
	 * per candidate with the move in its window alongside the history-only row.
	 */
	candidates?: readonly string[];
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
	/** Ensure the row for `ctx.chosenMove` is inferred (after the move is chosen, before `sample`). */
	prepareMove?(ctx: TimingContext, options?: TimingPreparation): Promise<void>;
	/** Source actually available for this position, including fallback failures. */
	diagnostics?(fen: string): TimingModelSource;
	/** Drop any per-game cache (called from `startGame`). */
	reset?(): void;
}
