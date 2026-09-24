/** Which reply the idle hand anticipates, and how often it acts on it. */

import { ANTICIPATION as A, type AnticipationKind } from "../constants/anticipation";
import type { OpponentExplorationCandidates, ReadStep } from "../opponent-candidates";
import type { TimeControlClass } from "../types";

export interface AnticipatedReply {
	kind: AnticipationKind;
	/** The opponent's move we expect. */
	opponent: ReadStep;
	/** Our answer to it: the piece the hand rests on is `reply.from`. */
	reply: ReadStep;
}

/** The ponder's top line as an anticipation, or null when it does not carry our answer. */
export function anticipateReply(
	candidates: Pick<OpponentExplorationCandidates, "readings">
): AnticipatedReply | null {
	const top = candidates.readings?.find((reading) => reading.rank === 0);
	const opponent = top?.steps[0];
	const reply = top?.steps[1];
	if (!opponent || !reply || opponent.side !== "opponent" || reply.side !== "own") return null;
	return { kind: reply.to === opponent.to ? "recapture" : "ponder", opponent, reply };
}

/** Per-turn probability that the idle hand pre-positions over the answering piece. */
export function anticipationEngageProb(
	kind: AnticipationKind,
	tcClass: TimeControlClass | "untimed"
): number {
	return A.engageProb[kind][tcClass];
}

/**
 * The reply this turn's hand pre-positions for, if any: the ponder's top line, when this turn's
 * draw falls under that kind's odds. Never while a premove or a hold is armed, because that hand
 * already has its piece.
 */
export function engagedAnticipation(
	candidates: OpponentExplorationCandidates,
	draw: number,
	tcClass: TimeControlClass | "untimed"
): AnticipatedReply | null {
	const attention = candidates.attention;
	if (attention?.armed || attention?.repertoire?.premovePending) return null;
	const reply = anticipateReply(candidates);
	return reply && draw < anticipationEngageProb(reply.kind, tcClass) ? reply : null;
}
