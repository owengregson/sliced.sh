/**
 * The Maia-3 policy contract between the service worker (asks), the offscreen document (runs
 * the ONNX session) and the selector (draws the move). Pure types; no chrome context.
 */

import type { MaiaSize } from "@core/constants/maia";

/** One query: the position with its history and both ratings. Encoded in the offscreen host. */
export interface PolicyInferenceInputs {
	/** The size to answer with (`maiaSizeFor(targetElo)`); the reply names the size that answered. */
	size: MaiaSize;
	/** The position to move in. */
	fen: string;
	/**
	 * The last `MAIA_INPUT.history` positions oldest → newest, the last one **equal to `fen`**.
	 * Fewer are allowed (early in a game); the encoder repeats the earliest.
	 */
	historyFens: string[];
	/** Rating of the side to move (our effective Elo), raw (the model clamps to `[0, 5000]`). */
	selfElo: number;
	/** Rating of the opponent; the caller substitutes `selfElo` when none is known. */
	oppoElo: number;
}

/** The legal-move distribution and value the host answers with. */
export interface PolicyResult {
	/** `[uci, p]` over the position's legal moves (board frame, not mirrored), `p` summing to 1. */
	moves: Array<[string, number]>;
	/** Side-to-move `(loss, draw, win)` probabilities from the value head. */
	wdl: [number, number, number];
	size: MaiaSize;
	/** Inference wall time in the host, when reported. */
	ms?: number;
}

export interface PolicyPreparation {
	/** Give up after this many ms (default `MAIA.inferenceBudgetMs`). */
	budgetMs?: number;
	signal?: AbortSignal;
}

/** The service-worker side of the port (`createPolicyInferPort`). `null` = unavailable, use the engine's policy. */
export interface PolicyPort {
	infer(
		inputs: PolicyInferenceInputs,
		preparation?: PolicyPreparation
	): Promise<PolicyResult | null>;
	/** Load and warm a size ahead of its first query (the waiting view; a target-Elo change). */
	warm(size: MaiaSize): void;
	dispose(): void;
}
