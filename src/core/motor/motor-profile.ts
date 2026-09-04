/**
 * Motor profile modulation (Appendix G §8, §9.3): time control, persona and
 * move-type modulation, per-game ±10 % offsets, per-move lognormal noise and
 * the per-game path-style choice.
 */

import type { Rng } from "@core/rng";
import type { PersonaId } from "@typedefs/settings";
import {
	MOTOR_DEFAULTS,
	MOVE_KIND_MODULATION,
	PERSONA_MOTOR,
	PREVIEW,
	PROFILE_NOISE,
	PROMOTION_LOOK_DELAY_MS,
	STYLE_MIX_PER_GAME,
	TC_MODULATION,
} from "./constants";
import type { MotorMoveKind, MotorProfile, MotorStyle, MsRange, TimeControlClass } from "./types";

/** Uniform sample in the inclusive range. */
export function sampleRange(range: MsRange, rng: Rng): number {
	return range[0] + rng.next() * (range[1] - range[0]);
}

const FAST_TC: ReadonlySet<TimeControlClass> = new Set(["bullet", "blitz"]);

function scaleRange(r: MsRange, k: number): MsRange {
	return [r[0] * k, r[1] * k];
}

const prob = (p: number): number => Math.min(1, Math.max(0, p));

/**
 * The persona / time-control / move-kind profile of Appendix G §8: blitz is
 * faster and sloppier, classical slower with more hesitation, premoves ×0.7,
 * blitz captures ×0.8, promotions add the 150–400 ms look-delay.
 */
export function profileFor(
	persona: PersonaId,
	tcClass: TimeControlClass,
	moveKind: MotorMoveKind,
	base: MotorProfile = MOTOR_DEFAULTS
): MotorProfile {
	const tc = TC_MODULATION[tcClass];
	const pm = PERSONA_MOTOR[persona];
	const mk = MOVE_KIND_MODULATION[moveKind];
	const kindApplies = !mk.fastTcOnly || FAST_TC.has(tcClass);
	const speed = pm.speed * (kindApplies ? mk.speed : 1);
	const reaction = kindApplies ? mk.reaction : 1;
	const merged: MotorProfile = { ...base, ...tc };
	return {
		...merged,
		reactionMs: scaleRange(merged.reactionMs, reaction),
		fittsA: merged.fittsA * pm.fittsA,
		travelSpeedScale: merged.travelSpeedScale * speed,
		jitterPx: merged.jitterPx * pm.jitter,
		hesitationProb: prob(merged.hesitationProb * pm.hesitation),
		microCorrectionProb: prob(merged.microCorrectionProb * pm.microCorrection),
		lookDelayMs: moveKind === "promotion" ? PROMOTION_LOOK_DELAY_MS : [0, 0],
		styleMix: { ...merged.styleMix },
		exploration: { ...merged.exploration, previewBase: PREVIEW.base[persona] },
	};
}

function jitterProfile(p: MotorProfile, factor: () => number): MotorProfile {
	const r = (range: MsRange): MsRange => {
		const k = factor();
		return [range[0] * k, range[1] * k];
	};
	return {
		...p,
		reactionMs: r(p.reactionMs),
		fittsA: p.fittsA * factor(),
		fittsB: p.fittsB * factor(),
		travelSpeedScale: p.travelSpeedScale * factor(),
		peakSpeedCapPxPerS: p.peakSpeedCapPxPerS * factor(),
		jitterPx: p.jitterPx * factor(),
		overshootProb: prob(p.overshootProb * factor()),
		hesitationProb: prob(p.hesitationProb * factor()),
		microCorrectionProb: prob(p.microCorrectionProb * factor()),
		pressHoldMs: r(p.pressHoldMs),
		grabDelayMs: r(p.grabDelayMs),
		releaseSettleMs: r(p.releaseSettleMs),
		lookDelayMs: r(p.lookDelayMs),
		styleMix: { ...p.styleMix },
		exploration: {
			...p.exploration,
			hoverProb: prob(p.exploration.hoverProb * factor()),
			feintProb: prob(p.exploration.feintProb * factor()),
		},
	};
}

/**
 * The session's stable "hand": every parameter offset by ±10 % (independently)
 * and a dominant path style chosen for the whole game (70/30, never per move).
 */
export function perGameProfile(base: MotorProfile, rng: Rng): MotorProfile {
	const o = PROFILE_NOISE.perGameOffset;
	const jittered = jitterProfile(base, () => 1 - o + rng.next() * 2 * o);
	const dominant = chooseStyle(base.styleMix, rng);
	return { ...jittered, styleMix: { ...STYLE_MIX_PER_GAME[dominant] } };
}

/** Per-move lognormal noise (σ 0.1) clamped to ±25 % so no two moves share parameters. */
export function perMoveProfile(profile: MotorProfile, rng: Rng): MotorProfile {
	const c = PROFILE_NOISE.perMoveClamp;
	return jitterProfile(profile, () =>
		Math.min(1 + c, Math.max(1 - c, rng.logNormal(0, PROFILE_NOISE.perMoveSigma)))
	);
}

/** Bezier or WindMouse according to the mix. */
export function chooseStyle(mix: MotorProfile["styleMix"], rng: Rng): MotorStyle {
	const total = mix.bezier + mix.wind;
	if (total <= 0) return "bezier";
	return rng.chance(mix.wind / total) ? "wind" : "bezier";
}
