/**
 * Selection-layer types (Task 14). `ChosenMove` / `EvalLine` come from
 * `@typedefs/*` and are never redefined here.
 */

import type { PositionHistory } from "@core/chess/history";
import type { Phase } from "@core/chess/phase";
import type { Rng } from "@core/rng";
import type { Settings } from "@typedefs/settings";

export type SelectionMode = Settings["strength"]["selectionMode"];

/** Per-game counters carried across `selectMove` calls (§7.2 steps 6–7 streak terms). */
export interface SelectionState {
	/** Consecutive top-1 picks; τ ×1.3 once it reaches 12. */
	top1Streak: number;
	/** Moves remaining with the blunder channel damped ×0.3 (3 after an injected blunder). */
	blunderDamperLeft: number;
	/** Our most recent own moves (UCI, oldest first, capped) for the back-and-forth prior row. */
	previousOwnMoves: string[];
}

/** Inputs to `selectMove` (§7.2). `lines` are side-to-move POV. */
export interface SelectionContext {
	fen: string;
	history?: PositionHistory;
	targetElo: number;
	/** Per-game AR(1) form latent in [−1, 1] (`persona.ts`). */
	form: number;
	ply: number;
	phase: Phase;
	myClockMs: number;
	oppClockMs: number;
	/**
	 * The game's starting clock in ms, when the page has answered its time control. It is what makes
	 * the §7.2 step 6 clock-pressure term mean the same thing in a 1+0 and a 10+0 game; absent (an
	 * untimed game, or a control that has not arrived yet) the absolute ramp applies alone.
	 */
	baseMs?: number;
	/** Increment mitigates the opponent's apparent time trouble. */
	incrementMs?: number;
	/** The opponent's last move (UCI); enables the recapture row. */
	lastMove?: string;
	selectionMode: SelectionMode;
	/** The engine's `UCI_Elo`-limited `bestmove` (§7.1). */
	engineBestmove?: string;
	/** `Settings.strength.blunderScale`. */
	blunderScale: number;
	/**
	 * §7.5 quality guard: a search shallower than `SEARCH_BUDGET.shallowDepth` is already
	 * "human-ish", so the session passes the top two lines with τ halved. Default 1.
	 */
	tauScale?: number;
	rng: Rng;
	state: SelectionState;
}

/** The subset of the context the (pure, deterministic) heuristic prior reads. */
export type PriorContext = Pick<
	SelectionContext,
	"targetElo" | "form" | "ply" | "phase" | "lastMove" | "state"
>;
