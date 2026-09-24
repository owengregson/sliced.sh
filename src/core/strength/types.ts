/**
 * Selection-layer types (Task 14). `ChosenMove` / `EvalLine` come from
 * `@typedefs/*` and are never redefined here.
 */

import type { PositionHistory } from "@core/chess/history";
import type { Phase } from "@core/chess/phase";
import type { MaiaCalibrationTable } from "@core/constants/maia-calibration";
import type { PolicyResult } from "@core/policy/types";
import type { Rng } from "@core/rng";
import type { EvalLine } from "@typedefs/engine";
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
	/**
	 * `cpRaw` of our previous pick, our POV (H12, 2026-09-13): the tilt trigger compares the next
	 * position's top raw score against it. Absent before the first pick and after an unscored one.
	 */
	lastPickCp?: number;
	/** Moves left with the H12 tilt penalty on the Maia rating (`0` = not tilted). */
	tiltMovesLeft: number;
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
	/** The engine's bestmove; engineResultKind records whether a strength limiter produced it. */
	engineBestmove?: string;
	/** Explicit provenance prevents an unrestricted referee answer being treated as native limiting. */
	engineResultKind?: "native-limited" | "unrestricted";
	/** `Settings.strength.blunderScale`. */
	blunderScale: number;
	/** Optional explicit temperature adjustment; search depth does not alter it. Default 1. */
	tauScale?: number;
	/**
	 * The Maia-3 policy's answer for `fen` (2026-09-11). When present and `usesMaia(targetElo)`
	 * holds, `selectMove` draws from it over the engine's scored lines (`maia-select.ts`)
	 * instead of the §7.2 base policy; absent, everything is as before.
	 */
	maia?: PolicyResult;
	/**
	 * The root moves among `lines` that the extra `go searchmoves` referee search on Maia's
	 * unscored favourites added (2026-09-12) — accounting for the rationale only; their scores are
	 * drawn over exactly like the main set's.
	 */
	maiaExtra?: readonly string[];
	/**
	 * The same search's complete MultiPV frame at the *human* depth (2026-09-13, H3/H4 of
	 * `docs/research/human-move-selection-ideas-2026-09-13.md`): `AnalysisResult.atFeatureDepth`
	 * captured at `humanDepth(E)`. Upper-range verification also incorporates the bounded
	 * referee evidence. Absent when the search never completed the requested comparison depth.
	 */
	shallowLines?: readonly EvalLine[];
	/** The depth `shallowLines` were captured at. */
	shallowDepth?: number;
	/**
	 * H5's pipeline-side context penalty in Elo (≥ 0): the clock and short-think terms the
	 * pipeline computed *before* the Maia query, so the query's `selfElo` and the selector's rails
	 * judge at one rating. The ambiguity term (Maia's own entropy) is added inside the selector.
	 */
	contextEloPenalty?: number;
	/**
	 * Maia strength calibration override (the calibration harness's sweep). Absent = the shipped
	 * `MAIA_CALIBRATION`; the pipeline never sets it.
	 */
	maiaCalibration?: MaiaCalibrationTable;
	rng: Rng;
	state: SelectionState;
}

/** The subset of the context the (pure, deterministic) heuristic prior reads. */
export type PriorContext = Pick<
	SelectionContext,
	"targetElo" | "form" | "ply" | "phase" | "lastMove" | "state"
>;
