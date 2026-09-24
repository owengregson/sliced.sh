/** The premove path's inputs, dependencies and result. */

import type { PositionHistory } from "@core/chess/history";
import type { PolicyResult } from "@core/policy/types";
import type { Rng } from "@core/rng";
import type { EvalLine } from "@typedefs/engine";
import type { Square, TimeControl } from "@typedefs/game";

export interface PremoveContext {
	/** Position before our move. */
	fen: string;
	/** Our chosen move `m` (UCI). */
	move: string;
	/** Effective Elo `E`. */
	targetElo: number;
	timeControl?: TimeControl | undefined;
	/** The engine's `ponder` move after `m`, when it reported one. */
	ponder?: string | undefined;
	rng: Rng;
	/** Timing-model premove propensity π_p in [0, 1] (default 1). */
	piP?: number | undefined;
	/**
	 * The think-time calibration's attempt probabilities (`premovePropensity`), already scaled by
	 * the persona; each replaces `tradePremoveProbability` / `premoveProbability` when present.
	 */
	propensity?: { trade?: number; ordinary?: number; tradeReplyMinProb?: number } | undefined;
	/** Validated game history through our move, for the projected reply search. */
	historyAfterMove?: PositionHistory;
	ownClockMs?: number;
	opponentClockMs?: number;
	/**
	 * H8: the human policy's answer for one predicted position (`fen` = the board after `m r`).
	 * Gates a candidate in that position through `maiaPremoveGate`; a candidate in any other
	 * position is not gated (the answer is for the wrong board).
	 */
	policy?: PredictedPolicy | undefined;
}

/** A Maia answer bound to the position it was asked about. */
export interface PredictedPolicy {
	fen: string;
	result: PolicyResult;
}

export interface AnalyseOptions {
	movetimeMs: number;
	multiPv: number;
}

export interface PremoveDeps {
	/** MultiPV lines (side-to-move POV) after playing `moves` from `fen`. */
	analyseAfter(fen: string, moves: readonly string[], opts: AnalyseOptions): Promise<EvalLine[]>;
}

export type PremoveReason = "recapture" | "only-move" | "loss2nd" | "king-escape";

export interface PremoveCandidate {
	/** The opponent reply `r` the premove is conditioned on. */
	reply: string;
	/** Our premove `q`. */
	premove: string;
	from: Square;
	to: Square;
	promotion?: "q" | "r" | "b" | "n";
	reason: PremoveReason;
	replyProbability: number;
}
