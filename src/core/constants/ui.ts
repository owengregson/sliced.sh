import { MAIA } from "./maia";

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
	/**
	 * §5.3: after a slider commit, external values that disagree with it are ignored this long —
	 * the store's next snapshot can still carry the value from *before* the write.
	 */
	sliderCommitGraceMs: 800,
	/**
	 * §5.3: the numeric readout under the thumb of a label-only slider (Variance, Motor speed)
	 * fades out this long after the last change; every change restarts the timer.
	 */
	sliderReadoutFadeMs: 1_500,
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
	/** Render running site clocks locally between panel snapshots, including tenths. */
	clockTickMs: 100,
	/** §5.5: eval jumps larger than this (fraction of the bar) use the faster transition. */
	evalJumpFraction: 0.3,
	/** §5.3: slider keyboard step multiplier with Shift / PageUp / PageDown. */
	sliderCoarseMultiplier: 10,
	/** §5.3: strength value from which the danger-zone hint shows. */
	/**
	 * Owner, 2026-09-15: "The cutoff for high strength range indicator should start at 3000 not
	 * 2600" — the product's one strength division (`MAIA.eloMax`), where Stockfish's large network
	 * takes over from Maia.
	 */
	strengthDangerElo: 3_000,
	/** §4.6 Account › License: the eye reveals the key for this long, then it re-masks. */
	licenseRevealMs: 10_000,
	/** Task 26 (§4.7): the engine view samples nps for the 60 s sparkline at this cadence. */
	sparklineSampleMs: 1_000,
	/** Task 23 / §4.10: clicks on the mark that open the cat-facts popover … */
	easterEggClicks: 7,
	/** … within this window. */
	easterEggWindowMs: 3_000,
} as const;

/**
 * Appendix F §7.2 strength labels, re-cut by the owner on 2026-09-15: a band applies from its `min`
 * up to the next band's `min` (400–799 Casual · 800–1399 Club · 1400–1799 Advanced · 1800–2199
 * Expert · 2200–2599 Master · 2600–2999 Elite · 3000–3399 Champion I · 3400–3800 Champion II —
 * the owner split Champion in two on 2026-09-15, at the midpoint, so both halves are 400 wide like
 * the bands below them). The only band table — the
 * Settings slider and the Live strength card both read it through `strengthBand`
 * (`panel/components/strength-threshold.ts`). The display copy for each band lives in
 * `panel/copy.ts` (`COPY.strength.bands`).
 */
export const STRENGTH_LABEL_BANDS = [
	{ min: 400, band: "casual" },
	{ min: 800, band: "club" },
	{ min: 1_400, band: "advanced" },
	{ min: 1_800, band: "expert" },
	{ min: 2_200, band: "master" },
	{ min: 2_600, band: "elite" },
	{ min: 3_000, band: "championI" },
	{ min: 3_400, band: "championII" },
] as const;

export type StrengthBand = (typeof STRENGTH_LABEL_BANDS)[number]["band"];
/** Task 24 — Live view strength card (Appendix F §4.4 item 7, §7.2 "Strength labels"). */
export const STRENGTH_UI = {
	/** Slider step for the target rating range in LIMITS. */
	sliderStep: 50,
	/**
	 * The restrained strength glow begins at the product's one strength division, the Maia cutoff
	 * where the full network takes over (owner, 2026-09-15) — not at a second number of its own.
	 */
	glowElo: MAIA.eloMax,
	/** Minor gray divisions; the network boundary remains the taller primary marker. */
	sliderTickStep: 200,
	/**
	 * Warm sweep cadence in the hot range, as the idle gap between two sweeps in units of the
	 * sweep's own width. The crossing speed never changes; the gap shrinks linearly from
	 * `flowGapMax` at `glowElo` (rare) to `flowGapMin` at the maximum (frequent). `slider.ts` reads
	 * it when it launches the next sweep, never into a sweep already crossing. `flowGapMin` must
	 * stay above 0: that margin is what lets each sweep finish before it is launched again.
	 */
	flowGapMax: 3,
	flowGapMin: 0.2,
	/**
	 * One sweep's crossing in sweep widths — in from beyond the fill's left edge, out past its right
	 * (`@keyframes sl-strength-flow`) — over `strength-sweep`, so the speed is fixed.
	 */
	sweepTravelWidths: 2,
} as const;

/** Task 24 — Live view height strategy (Appendix F §8.2). */
export const LIVE_LAYOUT = {
	/** Step 6: below this available height (viewport − top bar − banner) the view scrolls with the move card pinned. */
	scrollBelowPx: 480,
} as const;
