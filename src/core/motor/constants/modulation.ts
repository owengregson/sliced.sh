/** Motor-profile modulation (Appendix G §8): time control, persona, move kind and per-game noise. */

import type { PersonaId } from "@typedefs/settings";
import type { MotorMoveKind, MotorProfile, MotorStyle, TimeControlClass } from "../types";

/** Appendix G §8 time-control modulation (partial overrides of `MOTOR_DEFAULTS`). */
export const TC_MODULATION: Readonly<Record<TimeControlClass, Partial<MotorProfile>>> = {
	bullet: {
		reactionMs: [120, 260],
		fittsA: 0.08,
		fittsB: 0.12,
		travelSpeedScale: 0.7,
		pressHoldMs: [35, 80],
		hesitationProb: 0.05,
		overshootProb: 0.1,
	},
	blitz: {
		reactionMs: [150, 350],
		fittsA: 0.08,
		fittsB: 0.12,
		travelSpeedScale: 0.75,
		pressHoldMs: [35, 80],
		hesitationProb: 0.05,
		overshootProb: 0.1,
	},
	rapid: {},
	classical: { travelSpeedScale: 1.3, hesitationProb: 0.2, releaseSettleMs: [30, 110] },
};

/**
 * Appendix G §8 modulation of the *exploration* rates by time-control class. `TC_MODULATION` is a
 * shallow override of the profile, so the nested `exploration` block cannot be modulated there
 * without repeating every field of it; this table scales the rates instead, once (C1).
 *
 * The hover appetite is the behaviour that reads as the hand "touching pieces before it moves"
 * (the owner's live game): measured over 420 moves of a simulated 3+0 game, the hand hovered a
 * candidate piece on 75 % of the moves whose pre-touch window was long enough to explore at all
 * — the slow, conspicuous moves a watcher notices — and on a saturated window at rapid the
 * unscaled model hovers on 0.775 of them.
 *
 * **The rule these numbers come from: hovering must be something the hand sometimes does, never
 * its default.** "Not its default" is `< 0.5` on the windows where the `hoverRampMs` ramp is
 * saturated, evaluated at four reasonable moves — production's worst case at the shipped
 * `Settings.engine.multiPv` of 4, since `n_reasonable` can never exceed the number of lines — where
 * the planner's `f = 1 + hoverNSlope·(n−1)` is 1.6. That caps the scale at
 * `0.5 / 1.6 / MOTOR_DEFAULTS.exploration.hoverProb` = 0.568, so rapid and classical take 0.55 —
 * the rule's own ceiling, rounded down. A faster clock browses less still: a blitz or bullet hand
 * goes straight for the piece. Realised rates on a 3500 ms window (3000 seeds, n = 4): bullet
 * 0.269, blitz 0.391, rapid and classical 0.426.
 *
 * **The limit of that guarantee: it holds at the shipped MultiPV, not at every setting.** The
 * n-term keeps rising, and a user who raises `multiPv` toward `LIMITS.multiPvMax` (8) takes the
 * rapid rate back to where the complaint started — model 0.726 at n = 8, realised 0.59 on a
 * 3500 ms window and ≈ 0.70 on longer ones. Raising the shipped default therefore means
 * re-deriving this table, which `motor-profile.test.ts` makes a failing test rather than a
 * judgement call. There is no behaviour dataset behind any of this (see `MOTOR_DEFAULTS`); the
 * rule is the justification, and this table is the lever if the owner still sees the hand
 * touching pieces.
 */
export const TC_EXPLORATION: Readonly<Record<TimeControlClass, { hoverProb: number }>> = {
	bullet: { hoverProb: 0.35 },
	blitz: { hoverProb: 0.5 },
	rapid: { hoverProb: 0.55 },
	classical: { hoverProb: 0.55 },
};

/** Mild persona modulation (Elo affects think time far more than motor time). */
export const PERSONA_MOTOR: Readonly<
	Record<
		PersonaId,
		{ fittsA: number; jitter: number; hesitation: number; microCorrection: number; speed: number }
	>
> = {
	cautious: { fittsA: 1.1, jitter: 1.1, hesitation: 1.3, microCorrection: 1.2, speed: 1 },
	balanced: { fittsA: 1, jitter: 1, hesitation: 1, microCorrection: 1, speed: 1 },
	aggressive: { fittsA: 0.9, jitter: 0.9, hesitation: 0.8, microCorrection: 0.9, speed: 1 },
	blitz: { fittsA: 0.9, jitter: 1, hesitation: 0.7, microCorrection: 0.9, speed: 0.9 },
};

/** Move-type modulation: premoves ×0.7, blitz captures ×0.8, promotions add the look-delay. */
export const MOVE_KIND_MODULATION: Readonly<
	Record<MotorMoveKind, { speed: number; reaction: number; fastTcOnly: boolean }>
> = {
	normal: { speed: 1, reaction: 1, fastTcOnly: false },
	premove: { speed: 0.7, reaction: 0.7, fastTcOnly: false },
	capture: { speed: 0.8, reaction: 1, fastTcOnly: true },
	recapture: { speed: 0.8, reaction: 0.9, fastTcOnly: true },
	promotion: { speed: 1, reaction: 1, fastTcOnly: false },
	castle: { speed: 1, reaction: 1, fastTcOnly: false },
};

/** Per-game ±10 % offsets, per-move lognormal noise (σ) clamped to ±25 %. */
export const PROFILE_NOISE = {
	perGameOffset: 0.1,
	perMoveSigma: 0.1,
	perMoveClamp: 0.25,
} as const;

/** Per-game dominant path style (70/30), never a per-move coin flip. */
export const STYLE_MIX_PER_GAME: Readonly<Record<MotorStyle, { bezier: number; wind: number }>> = {
	bezier: { bezier: 0.85, wind: 0.15 },
	wind: { bezier: 0.3, wind: 0.7 },
};
