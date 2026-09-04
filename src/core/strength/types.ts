/**
 * Selection-layer types (Task 14). `ChosenMove` / `EvalLine` come from
 * `@typedefs/*` and are never redefined here.
 */

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
	targetElo: number;
	/** Per-game AR(1) form latent in [−1, 1] (`persona.ts`). */
	form: number;
	ply: number;
	phase: Phase;
	myClockMs: number;
	oppClockMs: number;
	/** The opponent's last move (UCI); enables the recapture row. */
	lastMove?: string;
	selectionMode: SelectionMode;
	/** The engine's `UCI_Elo`-limited `bestmove` (§7.1). */
	engineBestmove?: string;
	/** `Settings.strength.blunderScale`. */
	blunderScale: number;
	rng: Rng;
	state: SelectionState;
}

/** The subset of the context the (pure, deterministic) heuristic prior reads. */
export type PriorContext = Pick<
	SelectionContext,
	"targetElo" | "form" | "ply" | "phase" | "lastMove" | "state"
>;
