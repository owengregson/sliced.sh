/**
 * Timing presets (Appendix F §4.6, checklist item 8). The Settings view's preset chips are
 * display-only: they show `PROFILE_FOR_TC_CLASS[detected]` for the detected time control unless
 * the stored profile is the user's own choice (`manual` / `custom`). These are the same rules as
 * pure functions, so the `GameSession` runs exactly what the chips show — and so both can be
 * tested without a session.
 */

import { effectivePremoveTendency, SETTING_GAIN } from "@core/constants/setting-gain";
import {
	MANUAL_TIMING_PROFILE,
	PROFILE_FOR_TC_CLASS,
	TIMING_PROFILE_KNOBS,
	type TimingProfile,
} from "@core/constants/timings";
import { tcClass } from "@core/timing/features";
import type { TimeControl } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";

const MS_PER_S = 1000;

/** The profiles a *detected* time control may select (the rest are the user's own choice). */
const DETECTABLE: ReadonlySet<TimingProfile> = new Set<TimingProfile>(["fast", "natural", "slow"]);

/**
 * The class the per-class gains read when the page has not told us the time control yet. Blitz,
 * because the cost is asymmetric: a rapid game paced as blitz loses a little realism for a move or
 * two, a blitz game paced as rapid loses the game.
 */
const UNKNOWN_TC_CLASS = "blitz" as const;

/**
 * The profile actually in force. A detected preset wins over a stored preset — which is what the
 * chips display; `manual` and `custom` are the user's own picks and are never overridden, and an
 * untimed game (or one whose time control is not known yet) keeps the stored value.
 */
export function effectiveTimingProfile(
	stored: TimingProfile,
	timeControl: TimeControl | undefined
): TimingProfile {
	if (!DETECTABLE.has(stored) || !timeControl) return stored;
	const cls = tcClass(timeControl.baseMs / MS_PER_S, timeControl.incMs / MS_PER_S);
	return cls === "untimed" ? stored : PROFILE_FOR_TC_CLASS[cls];
}

/**
 * `manual` shows the plan and never auto-plays (`COPY.timing.manualOnly`: "Never auto-plays;
 * shows recommendations only.").
 */
export function autoPlayAllowed(profile: TimingProfile): boolean {
	return profile !== MANUAL_TIMING_PROFILE;
}

/**
 * The knobs the timing model runs with: the user's sliders re-based by `SETTING_GAIN` (owner,
 * 2026-09-13 — the panel keeps showing the user's number; this is the one place the timing
 * sliders turn into model input) and then scaled by the effective preset, so the slider stays
 * meaningful under a preset. `manual` and `custom` carry no preset knob and take the gains alone.
 *
 * The base-speed gain is per time-control class (`SETTING_GAIN.speedScale` carries why), which is
 * the other reason this function needs the time control and not just the profile. A game whose
 * time control is not known yet takes the blitz value.
 */
export function timingSettingsFor(
	timing: Settings["timing"],
	timeControl: TimeControl | undefined
): Settings["timing"] {
	const profile = effectiveTimingProfile(timing.profile, timeControl);
	const knobs =
		profile === "fast" || profile === "natural" || profile === "slow"
			? TIMING_PROFILE_KNOBS[profile]
			: null;
	const cls = timeControl
		? tcClass(timeControl.baseMs / MS_PER_S, timeControl.incMs / MS_PER_S)
		: UNKNOWN_TC_CLASS;
	return {
		...timing,
		profile,
		speedScale: timing.speedScale * SETTING_GAIN.speedScale[cls] * (knobs?.speedScale ?? 1),
		longThinkFrequency: timing.longThinkFrequency * SETTING_GAIN.longThinkFrequency,
		premoveTendency: effectivePremoveTendency(timing.premoveTendency),
	};
}
