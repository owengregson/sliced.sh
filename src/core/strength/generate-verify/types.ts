/** The records generate-and-verify takes and returns. */

import type { Rng } from "@core/rng";

/** One survivor of the rails, as the Maia branch of `selectMove` hands it in. */
export interface GvCandidate {
	uci: string;
	/** Maia's untempered proposal mass, including any caller-supplied endgame preference. */
	p: number;
	/** The deep referee's score for the move, side-to-move POV cp (`cpEffective`). */
	deepCp: number;
	/** The same move's score in the shallow frame at the human depth, when that frame ranked it. */
	shallowCp?: number;
}

export interface GvInput {
	/** The scored candidates that survived the rails (mated, hangs, loss cap). */
	survivors: readonly GvCandidate[];
	/** Effective Elo the move is judged at. */
	E: number;
	/** The depth `shallowCp` values were captured at; absent when no shallow frame exists. */
	shallowDepth?: number;
	rng: Rng;
	/** Per-call override of `GENERATE_VERIFY.enabled`. */
	enabled?: boolean;
}

/** One row of the verification table, for the rationale and the meters. */
export interface GvConsidered {
	uci: string;
	p: number;
	/** Shallow score; 0 when unavailable in recognition mode. Upper mode may use deep cp. */
	cp: number;
	/** Compared score. Recognition mode keeps cp; upper mode adds Gaussian perception noise. */
	score: number;
	/** True when finite shallow evidence exists; false is unverified, never synthetic evidence. */
	verified: boolean;
}

export interface GvResult {
	uci: string;
	/** Candidates drawn (1 on the intuition path). */
	k: number;
	/** True when the move was played on recognition alone. */
	intuition: boolean;
	/** The depth the candidates were verified at; 0 when no shallow frame existed. */
	verifyDepth: number;
	/** The candidates in draw order with their scores. */
	considered: GvConsidered[];
	rationale: string[];
}
