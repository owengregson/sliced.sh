/**
 * Panel UI timing constants (Appendix F §5–§6). Every user-facing duration that is not a
 * motion token lives here so components never carry a numeric literal (C1).
 */
export const UI_TIMINGS = {
	/** §6.1: press-and-hold to arm auto-play. */
	armHoldMs: 600,
	/** §6.1 step 5: keybind pre-arm window ("press A again to cancel"). */
	preArmMs: 1_000,
	/** §5.11: success / info toasts. */
	toastShortMs: 2_400,
	/** §5.11: warn / danger toasts (with action). */
	toastLongMs: 6_000,
	/** §5.12: tooltip hover delay (instant on focus). */
	tooltipDelayMs: 300,
	/** §5.5: eval bar goes stale when the engine has been idle this long. */
	engineStaleMs: 5_000,
	/** §5.10: the armed play button's `aria-live` countdown updates per whole second. */
	ariaCountdownStepMs: 1_000,
	/** §7.4: `announce()` collapses a burst of live-region updates into the last one. */
	announceDebounceMs: 150,
	/** §6.2: countdown label shows tenths above this remaining time, whole seconds below. */
	countdownTenthsAboveMs: 1_000,
	/** §5.9: clock shows tenths under 10 s. */
	clockTenthsBelowMs: 10_000,
	/** §5.9: active clock turns danger-text under 20 s. */
	clockLowMs: 20_000,
	/** §5.5: eval jumps larger than this (fraction of the bar) use the faster transition. */
	evalJumpFraction: 0.3,
	/** §5.3: slider keyboard step multiplier with Shift / PageUp / PageDown. */
	sliderCoarseMultiplier: 10,
	/** §5.3: strength value from which the danger-zone hint shows. */
	strengthDangerElo: 2_600,
	/** §4.6 Account › License: the eye reveals the key for this long, then it re-masks. */
	licenseRevealMs: 10_000,
	/** Task 26 (§4.7): the engine view samples nps for the 60 s sparkline at this cadence. */
	sparklineSampleMs: 1_000,
} as const;

/**
 * Appendix F §7.2 strength labels: a band applies from its `min` up to the next band's `min`
 * (400–799 Casual · 800–1399 Club · 1400–1999 Expert · 2000–2599 Master · 2600+ Elite). The
 * display copy for each band lives in `panel/copy.ts` (`COPY.strength.bands`).
 */
export const STRENGTH_LABEL_BANDS = [
	{ min: 400, band: "casual" },
	{ min: 800, band: "club" },
	{ min: 1_400, band: "expert" },
	{ min: 2_000, band: "master" },
	{ min: 2_600, band: "elite" },
] as const;

export type StrengthBand = (typeof STRENGTH_LABEL_BANDS)[number]["band"];
