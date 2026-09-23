/** The pitch a `mate` rating's sound plays at, along a mating sequence. */

import { MOVE_QUALITY as Q } from "@core/constants/move-quality";

/** The mover's previous `mate` rating in a sequence, as its sound was pitched. */
export interface MateNote {
	/** Moves to checkmate, that move included. */
	mateIn: number;
	/** The semitones its sound was given. */
	semitones: number;
}

/**
 * The forced-mate pitch of a move `mateIn` moves from checkmate (1 = the checkmate), in semitones
 * from `forced.mp3`: `MOVE_QUALITY.mateTopSemitones` at the checkmate, one `mateSemitoneStep`
 * lower per move further out, never below `mateMinSemitones` nor above the top.
 */
export function matePitch(mateIn: number): number {
	const pitch = Q.mateTopSemitones - (mateIn - 1) * Q.mateSemitoneStep;
	return Math.min(Q.mateTopSemitones, Math.max(Q.mateMinSemitones, pitch));
}

/**
 * The semitones a `mate` rating's sound plays at, given the same mover's previous move in the
 * sequence (owner, 2026-09-15). The checkmate is always the top step. A sequence starting here,
 * making progress, or restarting because mate grew further away plays `matePitch(mateIn)`. A
 * tangential move — mate exactly as far away as before — plays the average of the previous pitch
 * and the next step's, so repeated ones creep upward and never pass that step.
 */
export function mateSemitones(mateIn: number, previous?: MateNote): number {
	if (mateIn <= 1) return Q.mateTopSemitones;
	if (previous === undefined || mateIn !== previous.mateIn) return matePitch(mateIn);
	return (previous.semitones + matePitch(mateIn - 1)) / 2;
}
