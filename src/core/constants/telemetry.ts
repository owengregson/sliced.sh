/**
 * Telemetry conformance bands (Part I §13, §9.6a, §8.4a, §13.6) — every
 * threshold `assertHumanShapedAc` (tools/telemetry-conformance/ac-model.ts)
 * and the offline report (`report.py`, whose mirrored `BANDS` block is checked
 * against this registry by `tools/telemetry-conformance/bands.test.ts`) apply
 * to a move's `ac` blob, once (C1).
 * Numbers that already live in another registry are referenced, not copied.
 */

import {
	CLICK,
	MOTOR_DEFAULTS,
	PATH,
	PREVIEW,
	PROFILE_NOISE,
	SAMPLE_INTERVAL_MS,
} from "@core/motor/constants";
import { TIMING_CONSTANTS } from "@core/timing/constants";

/** Both profile jitters at their upper clamp: the widest a sampled motor range can get. */
const MAX_PROFILE_STRETCH = (1 + PROFILE_NOISE.perGameOffset) * (1 + PROFILE_NOISE.perMoveClamp);

/**
 * Largest single pointer step the hand can produce: the profile's speed cap
 * (with the per-game and per-move jitter both at their upper clamp) over one
 * sample interval, plus the generator's step margin, rounded up to a whole pixel. A larger
 * step is a teleport.
 */
const MAX_HAND_STEP_PX = Math.ceil(
	(MOTOR_DEFAULTS.peakSpeedCapPxPerS * MAX_PROFILE_STRETCH * SAMPLE_INTERVAL_MS) / 1000 +
		PATH.stepLimitMarginPx
);

/**
 * Longest a committed press can be held: the profile's press-hold ceiling with both
 * jitters at their upper clamp. A click-click submits the move on the *press* while the
 * hand's drop time is taken at the release, so the page's `MoveHoldTime` can precede the
 * executor's `elapsedMs` by at most this.
 */
const MAX_PRESS_HOLD_MS = Math.ceil(MOTOR_DEFAULTS.pressHoldMs[1] * MAX_PROFILE_STRETCH);

export const TELEMETRY_BANDS = {
	/** §13.2: zero blur events for the entire game; `DidToggle` never. */
	blurCountMax: 0,
	/**
	 * §13.2 / §9.3a: the `DidSelectMultiplePieces` rate over non-trivial moves. The
	 * 4–12 % band is a **population** statistic — at p ≈ 8 % a single 25-move game
	 * spans 0–4 previews as ordinary binomial noise — so it is only asserted once the
	 * sample reaches `minMovesForBand` non-trivial moves, pooled across seeded games.
	 * A single game is held to the weak invariant alone: never 0 %, never 100 %, never
	 * above `hardMax`.
	 */
	multiSelect: {
		rate: [0.04, 0.12] as readonly [number, number],
		/** Never above this, whatever the sample size. */
		hardMax: 0.25,
		/** Fewest non-trivial moves before the population band is asserted. */
		minMovesForBand: 200,
		/**
		 * Fewest non-trivial moves before "never 0 %, never 100 %" is asserted — about one
		 * rapid game's worth. A handful of moves carries no information at p ≈ 7 %.
		 */
		minMovesForNonZero: 20,
		/** A move is non-trivial (preview-eligible) at or above this planned think time … */
		minThinkMs: PREVIEW.gZeroMs,
		/** … and with this much clock left (§9.3a: previews are off in time trouble). */
		minClockMs: PREVIEW.clockFloorMs,
	},
	/** §8.4a / §9.6a: the `MoveHoldTime` distribution. */
	holdTime: {
		/** Per-game coefficient of variation (after enough moves). */
		cvMin: TIMING_CONSTANTS.cvGuard.minCv,
		cvAfterMoves: TIMING_CONSTANTS.cvGuard.afterMoves,
		/** No non-premove/instant move completes faster than this. */
		minMs: TIMING_CONSTANTS.minNormalMs,
		/**
		 * Pearson correlation between ln(hold time) and ln(`n_reasonable`) (Appendix D §6; the
		 * model is log-normal, so the log scale is where its complexity term acts).
		 */
		complexityCorrMin: 0.2,
		/**
		 * The page's `MoveHoldTime` never runs past the hand's own drop time, and precedes
		 * it by at most one committed press hold (a click-click submits on the press).
		 */
		submitBeforeDropMaxMs: MAX_PRESS_HOLD_MS,
	},
	/** §13.6 / §8: think times compress under time pressure, never lengthen. */
	compression: {
		/** Moves with less clock than this are "under pressure" (§8 `compression.clockS`). */
		pressureClockMs: TIMING_CONSTANTS.compression.clockS * 1000,
		/** Moves with at least this much clock are the comfortable reference. */
		comfortableClockMs: 60_000,
		/** mean(hold | pressure) / mean(hold | comfortable) must stay below this. */
		maxMeanRatio: 0.85,
		/** Fewest moves on each side before the ratio is asserted. */
		minMovesPerSide: 10,
	},
	/** §8.4b item 2: perceptual latency after every opponent move. */
	orientationMinMs: TIMING_CONSTANTS.orientation.minMs,
	/** §13.5 / §9.6a: pointer continuity. */
	pointer: {
		maxStepPx: MAX_HAND_STEP_PX,
		/**
		 * Press and release of a click land within this distance. §13.5 states 2 px; the
		 * generator is tighter than that and the band follows it — `clickReleasePoint` offsets
		 * the *rounded* press point by an integer ±`CLICK.releaseDriftPx` on each axis and
		 * `CdpMouse` rounds every dispatch, so the furthest a release can land is that offset's
		 * diagonal.
		 */
		clickDriftMaxPx: CLICK.releaseDriftPx * Math.SQRT2,
	},
} as const;
