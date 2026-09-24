/**
 * The think-time calibration (2026-09-24): per chess.com time class, advertised rating and move
 * situation, how the timing model's sampled think is shifted, and how readily a forced-looking
 * reply is premoved, so that the bot's clock-recorded think times match real chess.com players of
 * that rating in that situation.
 *
 * Written by `tools/timing-calibration/fit.ts` from chess.com rated games
 * (`data/timing/calib/`), replaying the production timing path end to end (the shipped ChessMimic
 * bands, `TimingModel`, the session's premove arming and queueing, the search's preparation time
 * and the hand). `docs/qa/timing-calibration-2026-09-24.md` records the corpus, the fit and the
 * held-out verification. Do not hand-edit the knots: re-run the harness
 * (`tools/timing-calibration/README.md`).
 *
 * Per time class, `knots` are advertised ratings (ascending); every array below has one value per
 * knot, linear between knots and flat outside them.
 *
 *   budgetPower        (per class) how much of the move budget's compression of the learned
 *                      sample is kept (1 = all of it, the behaviour before)
 *   shift[situation]   log multiplier on the model's sampled think above its physical support
 *                      (0 = unchanged, −0.69 = half as long). It moves the think the model plans;
 *                      the search and the hand still bound what the clock records.
 *   premove.recapture  probability that an armed-able safe recapture is armed as a premove
 *                      (replaces `tradePremoveProbability`'s base); `null` keeps the propensity.
 *   premove.other      the same for the only move and the clearly-best reply (replaces
 *                      `premoveProbability`'s base); `null` keeps the propensity.
 *
 * The persona's premove tendency (`pi_p`, including the user's `premoveTendency` setting) still
 * scales both premove values around the calibrated mean (`TIMING_CALIBRATION_LIMITS.premovePersona`).
 */

export const TIMING_CALIBRATION_TIME_CLASSES = ["bullet", "blitz", "rapid"] as const;
export type TimingCalibrationTimeClass = (typeof TIMING_CALIBRATION_TIME_CLASSES)[number];

/**
 * The situation of the move the bot plays, most specific first (`calibrationSituation`):
 * the only legal move; a move of the opening book the session answered with; an obvious
 * recapture (the opponent's last move captured on a square, we capture back there, and the
 * material balance is restored); a reply to check; everything else.
 */
export const TIMING_CALIBRATION_SITUATIONS = [
	"forced",
	"book",
	"recapture",
	"check",
	"ordinary",
] as const;
export type TimingCalibrationSituation = (typeof TIMING_CALIBRATION_SITUATIONS)[number];

export interface TimingCalibrationClass {
	knots: readonly number[];
	/**
	 * How much of the move budget's compression of the learned sample is kept: the normalisation
	 * scales the sample above its support by `comp` (budget target over the head's mean, at most
	 * `moveTimeScale`); the calibrated scale is `moveTimeScale · (comp / moveTimeScale)^budgetPower`.
	 * 1 = the normalisation as is, 0 = the learned (clock-conditioned) distribution at the user's
	 * speed setting. Normal and long moves only.
	 */
	budgetPower: number;
	shift: Readonly<Record<TimingCalibrationSituation, readonly number[]>>;
	premove: {
		recapture: readonly number[] | null;
		other: readonly number[] | null;
	};
}

export type TimingCalibrationTable = Readonly<
	Record<TimingCalibrationTimeClass, TimingCalibrationClass>
>;

/** Bounds every value read from a table is clamped to (a corrupt or extrapolated knot stays sane). */
export const TIMING_CALIBRATION_LIMITS = {
	shiftMin: -1.5,
	shiftMax: 2.3,
	/**
	 * A positive shift (thinking longer than the budget allows) is faded out as the own clock runs
	 * down: full above `shiftClockFull` of the effective base clock (`pressure`, base + 40·inc),
	 * none below `shiftClockZero`, linear between, per time class. The replay on the bot's own clock
	 * flagged far more often than the humans without it, and bullet needs the fade to start
	 * earlier: every non-premoved bullet move costs the search and the hand (≈ 0.85 s), which the
	 * humans' 0.1 s premoves and sub-half-second replies never pay
	 * (`docs/qa/timing-calibration-2026-09-24.md`).
	 */
	shiftClockZero: { bullet: 0.3, blitz: 0.1, rapid: 0.1 } as Readonly<
		Record<TimingCalibrationTimeClass, number>
	>,
	shiftClockFull: { bullet: 0.6, blitz: 0.35, rapid: 0.35 } as Readonly<
		Record<TimingCalibrationTimeClass, number>
	>,
	budgetPowerMin: 0,
	budgetPowerMax: 1,
	premoveMin: 0,
	premoveMax: 1,
	/**
	 * The calibrated premove probability is the population mean. A persona's own propensity
	 * `σ(pi_p + piOffset)` (0.5 on average) scales it by `premove(σ) / premove(0.5)`:
	 * `p = cal · (1 + premovePersona · (σ − 0.5) / 0.5)`, so a cautious or premove-happy persona (or
	 * the user's premove-tendency setting) still moves it.
	 */
	premovePersona: 1,
} as const;

const ZERO = [0] as const;

function identityClass(): TimingCalibrationClass {
	return {
		knots: [1500],
		budgetPower: 1,
		shift: { forced: ZERO, book: ZERO, recapture: ZERO, check: ZERO, ordinary: ZERO },
		premove: { recapture: null, other: null },
	};
}

/** No calibration: the behaviour before 2026-09-24 (tests of the mechanics and the baseline pin it). */
export const TIMING_CALIBRATION_IDENTITY: TimingCalibrationTable = {
	bullet: identityClass(),
	blitz: identityClass(),
	rapid: identityClass(),
};

// fitted-table-begin
export const TIMING_CALIBRATION: TimingCalibrationTable = {
	bullet: {
		knots: [800, 1200, 1600, 2000, 2400, 2800, 3100],
		budgetPower: 1,
		shift: {
			forced: [1, 1, 1, 1, 0.6, 0.6, 0.6],
			book: [-0.6, -0.6, -0.6, -1, -1, -1, -1],
			recapture: [1.8, 1.8, 1.4, 1.4, 1, 1, 1],
			check: [2.2, 2.2, 1.8, 2.2, 2.2, 2.2, 1.8],
			ordinary: [1.4, 1, 1, 1, 1, 1, 0.3],
		},
		premove: { recapture: [0.357, 0.502, 0.555, 0.708, 0.816, 0.891, 0.99], other: null },
	},
	blitz: {
		knots: [800, 1200, 1600, 2000, 2400, 2800, 3100],
		budgetPower: 0,
		shift: {
			forced: [-0.4, -0.2, 0, 0, 0, 0, 0],
			book: [-1, -1, -1, -1, -0.4, -0.4, -0.4],
			recapture: [-0.6, -0.4, -0.4, -0.4, 0, 0.4, 0.4],
			check: [-0.4, -0.4, -0.4, -0.2, -0.2, 0, -0.2],
			ordinary: [-0.4, -0.4, -0.4, -0.2, 0, 0, 0],
		},
		premove: { recapture: [0.19, 0.19, 0.22, 0.341, 0.375, 0.447, 0.543], other: null },
	},
	rapid: {
		knots: [800, 1200, 1600, 2000, 2400, 2800, 3100],
		budgetPower: 0,
		shift: {
			forced: [-0.4, -0.2, 0, -0.4, -0.2, -0.6, -0.6],
			book: [-0.6, -0.4, 0.2, 0, -0.4, -0.6, -0.6],
			recapture: [-0.2, -0.2, 0.6, 0.4, 0, -0.2, -0.2],
			check: [0, 0, 0.6, 0.2, -0.2, -0.6, -0.6],
			ordinary: [0, 0, 1, 0.6, -0.2, -0.2, -0.2],
		},
		premove: { recapture: [0.072, 0.072, 0.092, 0.122, 0.277, 0.473, 0.473], other: null },
	},
};
// fitted-table-end
