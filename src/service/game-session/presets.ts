/**
 * Timing presets (Appendix F §4.6, checklist item 8). The Settings view's preset chips are
 * display-only: they show `PROFILE_FOR_TC_CLASS[detected]` for the detected time control unless
 * the stored profile is the user's own choice (`manual` / `custom`). These are the same rules as
 * pure functions, so the `GameSession` runs exactly what the chips show — and so both can be
 * tested without a session.
 */

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
 * The knobs the timing model runs with: the user's sliders scaled by the effective preset, so the
 * slider stays meaningful under a preset. `manual` and `custom` carry no knobs and pass through.
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
	if (!knobs) return timing.profile === profile ? timing : { ...timing, profile };
	return { ...timing, profile, speedScale: timing.speedScale * knobs.speedScale };
}
