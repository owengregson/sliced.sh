/**
 * The first stage: what the position and the clocks decide before any engine or policy work —
 * whether Maia selects the move, the search budget, the timing inference budget and Maia's
 * rating — and the shared preparation deadline every later stage must fit.
 */

import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { Color } from "@typedefs/game";

import { remainingClockMs } from "../clock";
import { type SearchBudget, tcSeconds } from "./budget";
import { type MaiaSearchInput, maiaSearchMode } from "./maia-search";
import {
	type MaiaEloContext,
	type OwnMoveBudgetInput,
	ownMoveBudget,
	ownMoveClockRace,
	ownMoveMaiaElo,
} from "./own-move";
import type { RecommendationInput } from "./types";

export interface OwnMoveContext {
	myColor: Color;
	baseSec: number;
	incSec: number;
	myClockMs: number;
	oppClockMs: number;
	/** `maiaSearchMode`: Maia selects the move and the search is its full-strength referee. */
	maia: boolean;
	budget: SearchBudget;
	/** Budget for the timing inference that overlaps the search. */
	timingBudgetMs: number;
	/** The query, selector and human-depth frame share the same rating inputs; null without Maia. */
	maiaElo: MaiaEloContext | null;
}

export function ownMoveContext(
	input: RecommendationInput,
	myColor: Color,
	hasPolicy: boolean
): OwnMoveContext {
	const { snapshot, settings } = input;
	const [baseSec, incSec] = tcSeconds(snapshot.timeControl);
	const myClockMs = remainingClockMs(snapshot, myColor, input.nowMs);
	const oppClockMs = remainingClockMs(snapshot, myColor === "w" ? "b" : "w", input.nowMs);
	const position = {
		fen: snapshot.fen,
		ply: snapshot.ply,
		myClockMs,
		oppClockMs,
		timeControl: snapshot.timeControl,
		tau: input.tau,
		budgetUsedRatio: input.budgetUsedRatio,
		targetElo: input.targetElo,
		form: input.form,
	};
	const mode: MaiaSearchInput = {
		targetElo: input.targetElo,
		policy: hasPolicy,
		clockRace: ownMoveClockRace(position) !== null,
	};
	const maia = maiaSearchMode(mode);
	const shape: OwnMoveBudgetInput = { ...position, maia };
	const budget = ownMoveBudget(shape, settings);
	// Opponent-only rush keeps its short move search, but can afford the usual
	// bounded timing inference. Otherwise a 30–70 ms search needlessly loses the
	// learned clock distribution even while our own clock is comfortable.
	const timingBudgetMs = ownMoveClockRace(position)?.opponentOnly
		? Math.max(TIMING_CONSTANTS.chessmimic.inferenceBudgetMs, budget.movetimeMs)
		: budget.movetimeMs;
	// The query, selector and human-depth frame share the same rating inputs.
	const maiaElo = maia ? ownMoveMaiaElo(shape, settings) : null;
	return { myColor, baseSec, incSec, myClockMs, oppClockMs, maia, budget, timingBudgetMs, maiaElo };
}

/** The shared preparation deadline, measured from when the recommendation began. */
export class PreparationWindow {
	readonly deadlineMs: number;

	constructor(
		readonly startedAt: number,
		budget: SearchBudget,
		private readonly now: () => number
	) {
		this.deadlineMs = startedAt + budget.movetimeMs;
	}

	/** `requested`, cut to the time left before the deadline; null once nothing is left. */
	remaining(requested: SearchBudget): SearchBudget | null {
		const remaining = Math.min(requested.movetimeMs, this.deadlineMs - this.now());
		return remaining > 0 ? { ...requested, movetimeMs: Math.max(1, Math.round(remaining)) } : null;
	}
}
