/**
 * Max-strength mode's one predicate (owner, 2026-09-15): "when elo rating bar is 3800 (aka
 * whatever the max is, basically just when its at 100%), just play the absolute best possible move
 * in every situation". Every lever of the mode asks this, and nothing else, so a 3799 target keeps
 * exactly today's behaviour. Knobs: `MAX_STRENGTH` (`src/core/constants/max-strength.ts`).
 */

import { LIMITS } from "@core/constants/limits";

/**
 * `true` when the **active** target — the session's `targetElo()`, i.e. the slider or an
 * opponent-matched target clamped to the ceiling — is at the top of the product scale. A
 * non-finite target is never max strength.
 */
export function isMaxStrength(targetElo: number): boolean {
	return Number.isFinite(targetElo) && targetElo >= LIMITS.eloMax;
}
