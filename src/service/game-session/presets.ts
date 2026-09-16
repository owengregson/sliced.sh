/**
 * The timing knobs a game actually runs on. The timing *presets* — `fast` / `natural` / `slow`,
 * plus `manual` and `custom` — were removed on 2026-09-15 at the owner's request ("remove the
 * timing presets 'fast natural slow' etc."), so the user's own sliders always apply, exactly as
 * the former `custom` profile did. What is left is one pure function of the stored settings and
 * the detected time control, so the `GameSession`'s knobs can be tested without a session.
 */

import {
	effectiveBaseSpeed,
	effectivePremoveTendency,
	SETTING_GAIN,
} from "@core/constants/setting-gain";
import { tcClass } from "@core/timing/features";
import type { TimingSettings } from "@core/timing/types";
import type { TimeControl } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";

const MS_PER_S = 1000;

/**
 * The class the per-class gains read when the page has not told us the time control yet. Blitz,
 * because the cost is asymmetric: a rapid game paced as blitz loses a little realism for a move or
 * two, a blitz game paced as rapid loses the game.
 */
const UNKNOWN_TC_CLASS = "blitz" as const;

/**
 * The knobs the timing model runs with: the user's sliders re-based by `SETTING_GAIN` (owner,
 * 2026-09-13 — the panel keeps showing the user's number; this is the one place the timing
 * sliders turn into model input).
 *
 * The gain is per time-control class (`SETTING_GAIN.moveTimeScale` carries why), which is why this
 * function needs the time control and not just the settings. A game whose time control is not
 * known yet takes the blitz value.
 *
 * **This is also the one place `timing.baseSpeed` is inverted** (owner, 2026-09-15). The user's
 * knob is a *speed* — higher means the whole move takes less wall-clock time — while the gain and
 * everything the model does with the result are *durations*. So the gain multiplies and the user's
 * speed divides, and what leaves this function is named `moveTimeScale`: no code downstream reads
 * a "speed" that means slowness.
 *
 * The hand's own movement takes the same `baseSpeed` through `executorSettingsFor`, so the
 * multiplier covers the whole move and not just the wait.
 */
export function timingSettingsFor(
	timing: Settings["timing"],
	timeControl: TimeControl | undefined
): TimingSettings {
	const cls = timeControl
		? tcClass(timeControl.baseMs / MS_PER_S, timeControl.incMs / MS_PER_S)
		: UNKNOWN_TC_CLASS;
	return {
		moveTimeScale: SETTING_GAIN.moveTimeScale[cls] / effectiveBaseSpeed(timing.baseSpeed),
		varianceScale: timing.varianceScale,
		premoveTendency: effectivePremoveTendency(timing.premoveTendency),
		longThinkFrequency: timing.longThinkFrequency * SETTING_GAIN.longThinkFrequency,
		respectBudget: timing.respectBudget,
	};
}
