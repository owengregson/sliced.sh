// src/offscreen/move-rating-sounds/clips.ts
/**
 * Which recording a verdict plays and how: the five rating clips at the shared playback
 * settings, and the forced-mate clip resampled to the pitch the chip asks for.
 */

import { MOVE_QUALITY } from "@core/constants/move-quality";
import {
	FORCED_MATE_SOUNDS,
	type ForcedMateSoundQuality,
	MOVE_RATING_PLAYBACK,
	MOVE_RATING_SOUNDS,
	type MoveRatingSoundQuality,
} from "@core/constants/sounds";

export interface Clip {
	filename: string;
	volume: number;
	playbackRate: number;
	preservesPitch: boolean;
}

const FORCED_MATE_QUALITY: ForcedMateSoundQuality = "mate";

/** The clip a request names, or `null` for anything this player does not own. */
export function clipFor(quality: unknown, mateSemitones: unknown): Clip | null {
	if (typeof quality !== "string") return null;
	if (quality === FORCED_MATE_QUALITY) {
		if (
			typeof mateSemitones !== "number" ||
			!Number.isFinite(mateSemitones) ||
			mateSemitones < MOVE_QUALITY.mateMinSemitones ||
			mateSemitones > MOVE_QUALITY.mateTopSemitones
		)
			return null;
		return {
			filename: FORCED_MATE_SOUNDS.file,
			volume: MOVE_RATING_PLAYBACK.volume * FORCED_MATE_SOUNDS.volumeScale,
			// The panel's own pitch system (its slider ticks): resampled, pitch and speed together.
			playbackRate: 2 ** (mateSemitones / FORCED_MATE_SOUNDS.semitonesPerOctave),
			preservesPitch: false,
		};
	}
	if (!Object.hasOwn(MOVE_RATING_SOUNDS, quality)) return null;
	return {
		filename: MOVE_RATING_SOUNDS[quality as MoveRatingSoundQuality],
		volume: MOVE_RATING_PLAYBACK.volume,
		playbackRate: MOVE_RATING_PLAYBACK.playbackRate,
		preservesPitch: true,
	};
}

/** Every file the player warms ahead of its first verdict. */
export const PRELOADED_CLIPS: readonly string[] = [
	...Object.values(MOVE_RATING_SOUNDS),
	FORCED_MATE_SOUNDS.file,
];
