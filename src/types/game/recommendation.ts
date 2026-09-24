/** The move the pipeline chose and the recommendation around it. */

import type { MaiaSize } from "@core/constants/maia";
import type { EvalLine } from "@typedefs/engine";
import type { TimingPlan } from "@typedefs/timing";
import type { PromoPiece, Square } from "./board";

export interface ChosenMove {
	uci: string;
	san: string;
	from: Square;
	to: Square;
	promotion?: PromoPiece;
	/** `maia` (2026-09-11): drawn from the Maia-3 human policy over the engine's scored lines. */
	source:
		| "engine-elo"
		| "sampled"
		| "blunder"
		| "mate"
		| "book"
		| "premove"
		| "maia"
		/** 2026-09-23: the endgame tablebase's move for a ≤ 7-man position (`@core/tablebase`). */
		| "tablebase";
	rankInLines: number;
	/** Raw searched centipawn loss, omitted when the scores are not comparable. */
	cpLoss?: number;
	quality?: {
		kind: "search" | "book";
		eligible: boolean;
		reason?:
			| "forced"
			| "mate"
			| "bound"
			| "shallow"
			| "unknown"
			| "depth-mismatch"
			| "incomplete"
			| "opponent-rush"
			| "book"
			| "tablebase";
		depth: number;
		candidates: number;
	};
	rationale: string[];
	/** `source === "maia"`: the model's probability of this move (raw, before tempering). */
	maiaProb?: number;
	/** Fidelity meters of the Maia draw that produced this move (2026-09-13). */
	maiaMeters?: MaiaMeters;
}

/**
 * How much of the move was Maia's and how much was ours (2026-09-13, §3.2 of
 * `docs/research/human-move-selection-ideas-2026-09-13.md`). Every field is per move, computed
 * inside the selector from numbers it already had; nothing here calibrates the model.
 */
export interface MaiaMeters {
	/** The rating the query and the rails judged at (after pressure, slider and context terms). */
	selfElo: number;
	/** Normalised entropy of Maia's legal-move distribution, `H / log(#legal)` in [0, 1]. */
	entropy: number;
	/** Σ p over the scored candidates the rails excluded. */
	railedMass: number;
	/** Σ p over Maia's legal moves the engine never scored (before the rails). */
	unscoredMass: number;
	/** KL(final draw weights ‖ Maia) over the drawn set — 0 when the wrapper changed nothing. */
	klFromMaia: number;
	/** Maia's 1-based rank of the pick among the survivors (`0` = not a Maia pick). */
	rank: number;
	/** Survivors the draw was over. */
	survivors: number;
	/** Generate-and-verify (H3): candidates drawn, or absent when the plain draw ran. */
	candidates?: number;
	/** H3: the depth the candidates were verified at. */
	verifyDepth?: number;
}

export interface Recommendation {
	chosen: ChosenMove;
	lines: EvalLine[];
	eval: EvalLine["score"];
	wdl?: [number, number, number];
	/**
	 * The Maia-3 policy's answer for this position when it was queried and arrived in budget —
	 * the size that answered, its side-to-move `(loss, draw, win)` and the host's inference wall
	 * time. Present whether or not the selector used it (`chosen.source === "maia"` says that);
	 * `wdl` above stays the engine's.
	 */
	maia?: {
		size: MaiaSize;
		wdl: [number, number, number];
		ms?: number;
		/** The model's probability of the chosen move when the selector drew from it (`chosen.maiaProb`). */
		p?: number;
		/** Positions the query carried (1 … `MAIA_INPUT.history`); `1` = the degenerate no-history case. */
		historyPlies?: number;
		/** The `selfElo` the query was issued at. */
		selfElo?: number;
		/** `chosen.maiaMeters` when the selector drew from the model. */
		meters?: MaiaMeters;
	};
	depth: number;
	nps: number;
	plan: TimingPlan;
	computedAt: number;
	fen: string;
}
