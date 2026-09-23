/**
 * Score arithmetic over UCI `score` fields: the scalar `cpEquivalent` consumers use, the
 * `Info` → `Eval` conversion and the engine's own line ordering.
 */

import type { Eval } from "@typedefs/engine";
import type { UciScore } from "../uci-parser";

/** `cpEquivalent` of a mate: `±(MATE_CP − MATE_CP_PER_PLY · plies)`. */
const MATE_CP = 2000;
const MATE_CP_PER_PLY = 10;

/**
 * Scalar centipawns for consumers that need one. UCI `mate n` is in moves;
 * the mating side needs `2n − 1` plies, the mated side `2n`. `mate 0` (the
 * side to move is checkmated) maps to `−MATE_CP`.
 */
export function cpEquivalent(score: Eval): number {
	if (score.mate !== undefined) {
		const m = score.mate;
		if (m === 0) return -MATE_CP;
		const plies = m > 0 ? 2 * m - 1 : -2 * m;
		return Math.sign(m) * Math.max(0, MATE_CP - MATE_CP_PER_PLY * plies);
	}
	return score.cp ?? 0;
}

export function toEval(score: UciScore): Eval {
	return score.type === "mate" ? { mate: score.value } : { cp: score.value };
}

/** Exact UCI ordering: every winning mate outranks cp, every losing mate ranks below it. */
export function compareScores(a: UciScore, b: UciScore): number {
	const tier = (score: UciScore): number => (score.type === "cp" ? 0 : score.value > 0 ? 1 : -1);
	const tierDifference = tier(b) - tier(a);
	if (tierDifference !== 0) return tierDifference;
	return a.type === "cp" ? b.value - a.value : a.value - b.value;
}
