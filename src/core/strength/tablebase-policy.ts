/**
 * When a tablebase answer is played (2026-09-23). Max strength always plays it: "the absolute best
 * possible move in every situation" is, in a ≤ 7-man position, the tablebase's. Below that the
 * answer replaces the human policy's move only as often as players of the rating are measured to
 * find perfect endgame moves beyond what the policy already plays — never below
 * `TABLEBASE_HUMAN.floorElo`, rarely at club level, and less often in 6–7-man positions whose wins
 * nobody finds by technique. Evidence and decision: `docs/qa/endgame-tablebases-2026-09-23.md`.
 */

import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { TABLEBASE, TABLEBASE_HUMAN } from "@core/constants/tablebase";
import type { Rng } from "@core/rng";
import { eloRamp } from "./elo-map";
import { isMaxStrength } from "./max-strength";

/**
 * The probability the tablebase's move is played at the session's `targetElo` (max strength) and
 * effective rating `E`, in a position of `pieces` men. Out of range is 0.
 */
export function tablebaseProbability(targetElo: number, E: number, pieces: number): number {
	if (!(pieces <= TABLEBASE.maxPieces)) return 0;
	if (isMaxStrength(targetElo)) return 1;
	const H = TABLEBASE_HUMAN;
	if (!(E >= H.floorElo)) return 0;
	// Above the Maia ceiling the full-strength engine already plays: continue to certainty at max.
	const p =
		E > MAIA.eloMax
			? eloRamp(E, MAIA.eloMax, H.maxProb, LIMITS.eloMax, 1)
			: eloRamp(E, H.floorElo, H.floorProb, H.fullElo, H.maxProb);
	return pieces > H.simpleMaxPieces ? p * H.largeScale : p;
}

export interface TablebaseDecision {
	use: boolean;
	/** The probability the draw was made at. */
	p: number;
}

/** One draw per position from the game's rng (no draw at all when the probability is 0 or 1). */
export function decideTablebase(
	targetElo: number,
	E: number,
	pieces: number,
	rng: Pick<Rng, "chance">
): TablebaseDecision {
	const p = tablebaseProbability(targetElo, E, pieces);
	return { use: p >= 1 || (p > 0 && rng.chance(p)), p };
}
