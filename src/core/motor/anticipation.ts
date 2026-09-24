/**
 * Anticipatory hover (2026-09-24). Three pure parts under `./anticipation/`:
 *
 * - `reply`: the reply this turn's hand may pre-position for, read from the ponder's top line
 *   (their expected move, then our answer; a recapture is the surest case), how often the idle
 *   hand actually does it (`anticipationEngageProb`, the table the timing replay harness shares)
 *   and the executor's once-per-turn engagement rule (`engagedAnticipation`).
 * - `execution`: the physical latency of a reply the hand anticipated: a short reaction instead
 *   of an orientation re-scan, a grasp from the hover point instead of an approach, and the
 *   carry. The timing model plans with it when the hand really was hovering over the moving
 *   piece (`TimingContext.hoverSquare`).
 * - `hover`: the hover spell (`planAnticipationHover`) and the tolerance test (`withinHover`).
 *
 * Nothing here dispatches input. The hover itself is free pointer movement, and it never
 * presses or selects.
 */

export { type AnticipatedExecution, anticipatedExecution } from "./anticipation/execution";
export { planAnticipationHover, withinHover } from "./anticipation/hover";
export {
	type AnticipatedReply,
	anticipateReply,
	anticipationEngageProb,
	engagedAnticipation,
} from "./anticipation/reply";
export type { AnticipationKind } from "./constants/anticipation";
