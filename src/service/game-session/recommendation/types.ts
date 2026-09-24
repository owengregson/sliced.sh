/** The pipeline's public input/output records and the records passed between its stages. */

import type { PositionHistory } from "@core/chess/history";
import type { MaiaSize } from "@core/constants/maia";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import type { PolicyPort, PolicyResult } from "@core/policy/types";
import type { Rng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import type { SelectionState } from "@core/strength/types";
import type { TablebasePort } from "@core/tablebase/client";
import type { TimingModel } from "@core/timing/timing-model";
import type { PositionSnapshot, Recommendation } from "@typedefs/game";
import type { PersonaId, Settings } from "@typedefs/settings";

import type { SearchBudget } from "./budget";

/** The engine surface the pipeline needs (`EngineController` satisfies it). */
export interface PipelineEngine {
	analyse(req: AnalysisRequest): AnalysisHandle;
	engineElo(): number | undefined;
}

export interface RecommendationInput {
	snapshot: PositionSnapshot;
	settings: Settings;
	/** The active target, already opponent-matched when that setting is enabled. */
	targetElo: number;
	persona: PersonaId;
	/** Per-game AR(1) form latent. */
	form: number;
	/** `Persona.tau` of the timing model's per-game persona. */
	tau: number;
	/** UCI moves played this game (oldest first). */
	moves: string[];
	/** Starting FEN and validated move history for repetition-aware searches. */
	history?: PositionHistory;
	expectedOppReply: string | null;
	oppThinkMsHistory: number[];
	myThinkMsHistory: number[];
	selectionState: SelectionState;
	/** Fraction of the starting clock already spent. */
	budgetUsedRatio: number;
	rng: Rng;
	/** Cancels the search when the position moves on. */
	signal?: AbortSignal | undefined;
	nowMs: number;
	engineReady: boolean;
	autoQueen: boolean;
	inputMethod: "drag" | "click";
	/** The opponent rating supplied to Maia; absent uses our own rating. */
	opponentElo?: number;
	/** Model size retained for the game; absent uses maiaSizeFor(targetElo). */
	maiaSize?: MaiaSize;
	/**
	 * Policy answer retained for exactly snapshot.fen; a mismatch is ignored.
	 * knownTopMoves records the engine roots used by predicted-position analysis so the
	 * own-move search can reproduce its cache key. Absent means only Maia's roots are known.
	 */
	policyAnswer?: {
		fen: string;
		identity: string;
		result: PolicyResult;
		selfElo: number;
		historyPlies: number;
		knownTopMoves?: string[];
	};
}

export interface RecommendationOutcome {
	rec: Recommendation;
	/** The number of "reasonable" moves the timing features derived (the hand's exploration size). */
	nReasonable: number;
	/** Whether the chosen move came from the opening book. */
	fromBook: boolean;
	/** Whether the chosen move came from the endgame tablebase (rated Book on the board). */
	fromTablebase?: boolean;
	budget: SearchBudget;
	/** `null` when the engine never answered (book-only or a failed search). */
	analysis: AnalysisResult | null;
}

export interface RecommendationPipelineDeps {
	engine: PipelineEngine;
	timing: TimingModel;
	book: BookPolicy | null;
	/** Optional Maia policy port; a missing answer uses engine selection. */
	policy?: PolicyPort;
	/** Optional endgame tablebase (2026-09-23); absent or unavailable, the engine plays. */
	tablebase?: TablebasePort | null;
	now?: () => number;
}

/** A Maia answer with its query rating and history coverage. */
export interface PolicyAnswer {
	result: PolicyResult;
	selfElo: number;
	historyPlies: number;
}

/** A pending Maia query and when it was issued (the budget is measured from there). */
export interface PolicyQuery {
	pending: Promise<PolicyResult | null>;
	issuedAt: number;
	abort: AbortController;
	selfElo: number;
	historyPlies: number;
}

/** A restricted search's roots, and whether it is the cacheable Maia-shaped own-move search. */
export interface SearchShape {
	searchmoves: readonly string[];
	shaped: boolean;
}
