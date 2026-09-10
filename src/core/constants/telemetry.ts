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

/** Standard deviations of the drag-preview return draw the conformance gate allows (§13.5). */
const DRAG_RETURN_SIGMAS = 5;

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
 * Longest a committed press can be held: the profile's press-hold ceiling with both jitters at
 * their upper clamp. It bounds how far the page's `MoveHoldTime` may precede the executor's
 * `elapsedMs`, which only a form that submits on the *press* can do. Click-to-move was removed end
 * to end, so every committed move now submits on the release and the bound is slack; it is kept as
 * the ceiling on that gap rather than silently dropped (see `submitBeforeDropMaxMs`).
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
		 * Rows the complexity axis needs before its correlation is asserted. Pearson r over two
		 * points is exactly ±1, so a barely-migrated export would coin-flip a PASS or a FAIL;
		 * below this the report prints r and says the sample is too small.
		 */
		complexityMinRows: 12,
		/**
		 * The page's `MoveHoldTime` never runs past the hand's own drop time, and precedes it by at
		 * most one committed press hold. This band existed only to police a click-committed move,
		 * which submitted on the press while the hand's drop time was taken at the release; with
		 * drag-only the quantity it bounds is ~0 and the band is slack. Left in place deliberately:
		 * it is the one §13 rule that keyed off the input method, and it still holds.
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
		 * The speed the *dispatched* pointer may reach, px/s. `MAX_HAND_STEP_PX` is that cap over
		 * one sample interval, so this is the same bound expressed per second — the one that has
		 * to hold once a path's `dtMs` is rescaled (Task 30 fits the approach to its window
		 * budget, `rescalePath`, which shortens the waits without moving the points).
		 */
		maxSpeedPxPerS: (MAX_HAND_STEP_PX * 1000) / SAMPLE_INTERVAL_MS,
		/**
		 * Press and release of a click land within this distance. §13.5 states 2 px; the
		 * generator is tighter than that and the band follows it — `clickReleasePoint` offsets
		 * the *rounded* press point by an integer ±`CLICK.releaseDriftPx` on each axis and
		 * `CdpMouse` rounds every dispatch, so the furthest a release can land is that offset's
		 * diagonal. Clamped to §13.5's stated 2 px: the derivation may only ever make this
		 * gate stricter than the spec, never looser (raising `releaseDriftPx` must not
		 * silently stop the suite enforcing §13.5).
		 */
		clickDriftMaxPx: Math.min(2, CLICK.releaseDriftPx * Math.SQRT2),
		/**
		 * A *drag* preview (§9.3a) presses a piece, drags out and releases back on the same
		 * square, so its press/release pair sits on the same square without being a click:
		 * `preview-select.ts` draws the release as `pressAt + N(0, PREVIEW.dragReturnSigmaPx)`
		 * per axis and clamps it inside the piece's own square. The drift is therefore a 2-D
		 * Gaussian radius, gated at `DRAG_RETURN_SIGMAS`σ — a radius beyond 5σ has probability
		 * `e^-12.5 ≈ 4 × 10⁻⁶` per press, so a generator that starts releasing away from its
		 * press fails at once, and the gate never widens to the square it is clamped into.
		 */
		dragReturnMaxPx: PREVIEW.dragReturnSigmaPx * DRAG_RETURN_SIGMAS,
	},
} as const;
