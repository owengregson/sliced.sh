/** One scored line as the selector weighs it, and the never-play rules judged per candidate. */

import { classifyMove } from "@core/chess/move-classify";
import { applyMoves, legalMoves } from "@core/chess/san";
import type { Rng } from "@core/rng";
import type { EvalLine } from "@typedefs/engine";
import { SELECTION_CONSTANTS as C } from "../constants";
import type { PriorTerm } from "../prior";

export interface Candidate {
	line: EvalLine;
	uci: string;
	/** 1-based rank by original raw engine score; 0 when there is no credible score. */
	rank: number;
	cpRaw: number;
	cpEff: number;
	/** Win-fraction loss from the jittered `cpEff` (policy). */
	loss: number;
	/** Win-fraction loss from the raw `cpRaw` (never-play rails). */
	lossRaw: number;
	prior: number;
	terms: readonly PriorTerm[];
	mate: number | undefined;
}

/** A usable line with its raw score and its position in the usable set (the sort's tiebreak). */
export interface RankedLine {
	line: EvalLine;
	i: number;
	cpRaw: number;
}

/** A line the engine scores as a forced loss for us. */
export function isMatedLine(c: Candidate): boolean {
	return c.mate !== undefined && c.mate < 0;
}

export function populationStd(values: readonly number[]): number {
	if (values.length === 0) return 0;
	let mean = 0;
	for (const v of values) mean += v;
	mean /= values.length;
	let sq = 0;
	for (const v of values) sq += (v - mean) ** 2;
	return Math.sqrt(sq / values.length);
}

/**
 * Never-play rule 4: the PV shows the opponent capturing next and the line
 * loses ≥ 0.25. `loss` is the raw (unjittered) win-fraction loss so the rail is hard.
 */
export function hangsPiece(line: EvalLine, loss: number, fen: string): boolean {
	if (loss < C.neverPlay.hangPieceLoss) return false;
	const replySan = line.pvSan[1];
	if (replySan !== undefined) return replySan.includes("x");
	const ours = line.pvUci[0];
	const reply = line.pvUci[1];
	if (ours === undefined || reply === undefined) return false;
	const after = applyMoves(fen, [ours]);
	if (after === null) return false;
	return classifyMove(after, reply)?.isCapture ?? false;
}

/**
 * §7.2 step 5's mated-line rule, shared by the base policy and the Maia draw (H16): a mated line
 * is excluded while an unmated alternative exists, except that below `matedAllowBelowElo` the
 * deep ones (≥ `matedMinDepth`) are allowed with `matedAllowProb`, drawn once per move. Returns
 * the "excluded as mated" predicate and leaves its rows in `rationale`.
 */
export function matedLineFilter(
	cands: readonly Candidate[],
	E: number,
	rng: Rng,
	rationale: string[]
): (c: Candidate) => boolean {
	const NP = C.neverPlay;
	const alternativeExists = cands.some((c) => !isMatedLine(c));
	const deep = (c: Candidate) => Math.abs(c.mate ?? 0) >= NP.matedMinDepth;
	let allowDeepMated = false;
	if (
		alternativeExists &&
		E < NP.matedAllowBelowElo &&
		cands.some((c) => isMatedLine(c) && deep(c))
	) {
		allowDeepMated = rng.chance(NP.matedAllowProb);
		if (allowDeepMated)
			rationale.push(
				`never-play: E<${NP.matedAllowBelowElo}, deep mated lines allowed (p=${NP.matedAllowProb})`
			);
	}
	const getsMated = (c: Candidate) =>
		alternativeExists && isMatedLine(c) && !(allowDeepMated && deep(c));
	const matedExcluded = cands.filter(getsMated).length;
	if (matedExcluded > 0) rationale.push(`never-play: ${matedExcluded} mated line(s) excluded`);
	return getsMated;
}

/** The lines whose first move is legal in `fen`: max-strength mode's only check on the engine's lines. */
export function legalLines(lines: readonly EvalLine[], fen: string): EvalLine[] {
	const legal = new Set(legalMoves(fen));
	return lines.filter((line) => legal.has(line.pvUci[0] ?? ""));
}
