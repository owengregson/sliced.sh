/** The public shapes of an opponent-turn exploration plan (one *spell* of the attention plan). */
import type { Square } from "@typedefs/game";
import type { ExplorationSide, OpponentExplorationCandidates } from "../opponent-candidates";
import type { RepertoireState } from "../repertoire";
import type { BoardGeometry, MotorProfile, PathPoint, Pt } from "../types";

export type { ExplorationSide } from "../opponent-candidates";

/** What a movement is part of (diagnostics and the unit tests; the hand treats every kind alike). */
export type ExplorationActivity =
	| "line"
	| "threat"
	| "candidates"
	| "king"
	| "offBoard"
	| "glance"
	| "compare"
	| "verify"
	| "relate"
	| "prepare"
	| "rest";

export interface OpponentExplorationAction {
	/**
	 * `hover`/`trace`: a path to a square and a dwell there. `rest`: a stationary dwell.
	 * `drift`: the idle tremor inside a dwell — a one-point path a few px away, then the rest of
	 * the dwell. `offBoard`: a path to a point beside the board (the clock / move list) and a dwell.
	 */
	kind: "hover" | "trace" | "rest" | "drift" | "offBoard";
	path?: PathPoint[];
	dwellMs: number;
	/** The candidate square this free movement considers, for diagnostics. */
	square?: Square;
	side?: ExplorationSide;
	activity?: ExplorationActivity;
}

/** The spell a plan is; the caller passes it back as `previousSpell` so spells alternate. */
export type ExplorationSpell = "first" | "active" | "glance" | "still";

export interface OpponentExplorationOptions extends OpponentExplorationCandidates {
	/** Strict ceiling on the entire spell, including orientation and terminal stillness. */
	maxMs?: number;
	/** Retain the previous plan's state; clear between games. Never contains coordinates. */
	repertoireState?: RepertoireState;
	geometry: BoardGeometry;
	profile: MotorProfile;
	cursor: Pt;
	/** The last inspected square of the previous bout; avoids restarting on the same piece. */
	previousTarget?: Square;
	/** The previous spell of this turn (absent for the first). */
	previousSpell?: ExplorationSpell;
	/** A no-ponder turn (`decideOpponentTurn`): stills only. */
	quiet?: boolean;
}

export interface OpponentExplorationPlan {
	repertoireState?: RepertoireState;
	actions: OpponentExplorationAction[];
	durationMs: number;
	lastTarget: Square | null;
	spell: ExplorationSpell;
}
