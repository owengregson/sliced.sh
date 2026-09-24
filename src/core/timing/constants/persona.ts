/** Appendix D §4 persona latents and the §8.4b item 5 bot-pace guard. */

import type { PersonaId } from "@typedefs/settings";

export interface ProfileOffsets {
	/** Log speed offset (`profile.speed`). */
	speed: number;
	/** Premove logit offset (`profile.premove`). */
	premove: number;
	/** Impulsiveness offset added to the Beta(2,2) draw. */
	iota: number;
}

/** Appendix D §4 persona latents (no `session_mu`, §8.4b item 4). */
export const PERSONA = {
	sGameSigma: 0.2,
	iotaBeta: [2, 2],
	piSigma: 0.5,
	tauSd: 0.12,
	mirrorRange: [0.05, 0.3],
	motorKMean: 1,
	motorKSd: 0.12,
	motorKMin: 0.4,
	/** Beta parameterisation keeps the τ mean strictly inside (0, 1). */
	tauMeanClamp: [0.05, 0.95],
	/** Appendix D §4 profiles mapped onto `PersonaId`: slow / normal / fast / blitz-specialist. */
	profiles: {
		cautious: { speed: 0.35, premove: -0.5, iota: -0.2 },
		balanced: { speed: 0, premove: 0, iota: 0 },
		aggressive: { speed: -0.35, premove: 0.5, iota: 0.2 },
		blitz: { speed: -0.35, premove: 1, iota: 0.2 },
	} as Record<PersonaId, ProfileOffsets>,
} as const;

/** §8.4b item 5: a bot opponent never drags us below this fraction of the model median. */
export const BOT_PACE_FLOOR = 0.6;

export const BOT_PACE = { minMoves: 3, maxReplyMs: 1500, maxCv: 0.35 } as const;
