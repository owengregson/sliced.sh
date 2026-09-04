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
} as const;
