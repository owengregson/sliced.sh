/**
 * The Maia strength calibration (2026-09-23): per chess.com time class, which rating Maia-3 is
 * conditioned at and at what sampling temperature, for each advertised chess.com rating.
 *
 * Maia-3 learned from Lichess ratings and is sampled over its whole legal-move distribution, so
 * asking it for rating R and drawing at T = 1 does not reproduce a chess.com R player's error rate:
 * the rating scales differ, the model's own uncertainty widens the tail it samples, and the
 * pipeline's context terms (clock, think, ambiguity, tilt, form, opponent pressure) move the query
 * further. The table maps the advertised rating to the two numbers that make the bot's
 * inaccuracy / mistake / blunder rates and ACPL match real chess.com players of that rating in
 * that time class, measured end to end through the shipped selector with those context terms on.
 *
 * Written by `tools/calibration/fit.ts` from `data/calibration/` (chess.com rated games, the
 * vendored Stockfish referee and the shipped Maia model); `docs/qa/maia-calibration-2026-09-23.md`
 * records the corpus, the fit and the held-out verification. Do not hand-edit the knots: re-run
 * the harness (`tools/calibration/README.md`).
 *
 * Knots are `[targetElo, conditioningElo, temperature]`, ascending in the target. Between knots
 * both values are linear; outside them the conditioning keeps the edge offset (slope 1) and the
 * temperature stays flat.
 */

export const MAIA_CALIBRATION_TIME_CLASSES = ["bullet", "blitz", "rapid"] as const;
export type MaiaCalibrationTimeClass = (typeof MAIA_CALIBRATION_TIME_CLASSES)[number];

export type MaiaCalibrationKnot = readonly [
	targetElo: number,
	conditioningElo: number,
	temperature: number,
];

export type MaiaCalibrationTable = Readonly<
	Record<MaiaCalibrationTimeClass, ReadonlyArray<MaiaCalibrationKnot>>
>;

/**
 * chess.com's time classes on the estimated game duration `base + incWeight·inc` (seconds): bullet
 * below `bulletMaxSec`, blitz below `blitzMaxSec`, rapid otherwise. Verified against the
 * `time_class` chess.com reports for every game of the calibration corpus. A game whose control
 * is not known yet is treated as `fallback`.
 */
export const MAIA_CALIBRATION_TIME_CLASS_RULE = {
	incWeight: 40,
	bulletMaxSec: 180,
	blitzMaxSec: 600,
	fallback: "blitz" as MaiaCalibrationTimeClass,
} as const;

/**
 * The identity calibration — condition at the advertised rating, sample at T = 1 — the behaviour
 * before 2026-09-23. Tests of the selector's mechanics pin it; the verification's baseline runs it.
 */
export const MAIA_CALIBRATION_IDENTITY: MaiaCalibrationTable = {
	bullet: [[1500, 1500, 1]],
	blitz: [[1500, 1500, 1]],
	rapid: [[1500, 1500, 1]],
};

export const MAIA_CALIBRATION: MaiaCalibrationTable = {
	bullet: [
		[600, 400, 0.6],
		[800, 400, 0.7],
		[1000, 400, 0.9],
		[1200, 400, 0.9],
		[1400, 600, 0.9],
		[1600, 800, 1],
		[1800, 900, 1],
		[2000, 1100, 1],
		[2200, 1200, 1.1],
		[2400, 1400, 1.1],
		[2600, 1700, 1],
		[2800, 1800, 1],
		[3000, 2000, 1],
	],
	blitz: [
		[600, 600, 0.7],
		[800, 800, 0.7],
		[1000, 800, 0.7],
		[1200, 1000, 0.7],
		[1400, 1100, 0.7],
		[1600, 1200, 0.6],
		[1800, 1400, 0.6],
		[2000, 1400, 0.7],
		[2200, 1700, 0.7],
		[2400, 1800, 0.7],
		[2600, 2000, 0.7],
		[2800, 2300, 0.7],
		[3000, 2500, 0.7],
	],
	rapid: [
		[600, 400, 0.3],
		[800, 600, 0.4],
		[1000, 700, 0.4],
		[1200, 800, 0.4],
		[1400, 900, 0.4],
		[1600, 1100, 0.3],
		[1800, 1400, 0.3],
		[2000, 1600, 0.3],
		[2200, 1800, 0.4],
		[2400, 2000, 0.4],
		[2600, 2300, 0.3],
		[2800, 2600, 0.3],
	],
};
