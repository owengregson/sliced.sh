/** The shapes the brilliant plan, its evidence and its verdict share. */

import type { BRILLIANT } from "@core/constants/review";

export type BrilliantTuning = { readonly [K in keyof typeof BRILLIANT]: number };

export type SacrificeShape =
	| "indirect"
	| "ignored-threat"
	| "hanging-piece"
	| "capture-sacrifice"
	| "exchange-sacrifice";

export interface SacrificeOffer {
	/** The opponent's legal capture after the move, in UCI. */
	capture: string;
	square: string;
	shape: SacrificeShape;
	/** Pawn units the mover loses in the legal exchange on `square`, net of the move's own gain. */
	concession: number;
	/**
	 * Taking the moved piece loses at least as much elsewhere, to a capture that already won it
	 * before the offer was accepted (`BRILLIANT.standingThreatMinRating`).
	 */
	standing?: boolean;
	/**
	 * Taking this piece is answered by a capture elsewhere that wins it back with check
	 * (`BRILLIANT.checkRecoveryMinRating`).
	 */
	checkRecovered?: boolean;
}

export interface BrilliantPlanInput {
	fen: string;
	uci: string;
	inBook?: boolean | undefined;
}

export interface BrilliantPlan extends BrilliantPlanInput {
	legalMoves: number;
	offers: SacrificeOffer[];
	/** False when a legal exchange exceeded the work bound; absence of proof is not safety. */
	materialComplete: boolean;
	/**
	 * Another legal move gives up less: its worst concession is smaller than this move's. (Not "no
	 * concession at all" — a piece already lost whatever is played does not make a sacrifice forced.)
	 */
	safeAlternative: boolean;
}

/** Another root move and its expected points for the mover. */
export interface BrilliantAlternative {
	uci: string;
	points: number;
	/** The same, at the mover's rating (`BRILLIANT.gratuitousRatedWinning`). */
	ratedPoints?: number | undefined;
	mate?: number | undefined;
}

export interface BrilliantEvidence {
	/** Expected points after the move, for the mover. */
	playedPoints: number;
	/** Soundness at the actual mover's rating; reference points remain the comparison scale. */
	ratedPlayedPoints?: number | undefined;
	/** The played move's score is a mate (sign from the mover's side). */
	playedMate?: number | undefined;
	/** Expected-points loss against the best move (reference curve). */
	loss: number;
	/** The same loss at the mover's rating (`BRILLIANT.nearBestRatedLoss`). */
	ratedLoss?: number | undefined;
	/** Every other scored root move of the same review. */
	alternatives: readonly BrilliantAlternative[];
	/** The engine's line starting with the played move (the illusion test reads it). */
	playedPv?: readonly string[] | undefined;
	moverRating?: number | undefined;
	/**
	 * The same player's move within `BRILLIANT.sequencePlies` already passed these gates: this
	 * sacrifice continues that attack.
	 */
	recentSacrifice?: boolean | undefined;
}

export type BrilliantReason =
	| "illegal"
	| "insufficient-evidence"
	| "book"
	| "forced"
	| "not-sacrifice"
	| "illusion"
	| "no-safe-alternative"
	| "unsound"
	| "not-near-best"
	| "trivial-win"
	| "mating-threat"
	| "continuation"
	| "sound-sacrifice";

export interface BrilliantVerdict {
	brilliant: boolean;
	reason: BrilliantReason;
	offers: readonly SacrificeOffer[];
}
