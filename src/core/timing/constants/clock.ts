/**
 * Clock policies around the head: opponent pressure, the clock race, time-pressure compression,
 * hard caps, the §8.4a floor and the Appendix D §5 re-plan rules.
 */

/** Post-model opponent-clock policy. Missing/untimed clocks leave both policies neutral. */
export const OPPONENT_PRESSURE = {
	thresholdBaseFraction: 0.12,
	thresholdMinMs: 8_000,
	thresholdMaxMs: 30_000,
	incrementHorizon: 3,
	ownClockRatioMin: 0.35,
	maxThinkReduction: 0.45,
} as const;

/** A fast execution policy after the timing head; searches and the hand share its budget. */
export const CLOCK_RACE = {
	opponentThresholdMs: 10_000,
	ownThresholdMs: 5_000,
	explorationLowClockMs: 10_000,
	opponentBaseUrgency: 0.55,
	ownBaseUrgency: 0.65,
	incrementHorizon: 3,
	/**
	 * Own-clock emergency windows, interpolated by urgency. Raised on 2026-09-11 (owner: "still
	 * making superhuman speed movements"): the whole move at full urgency is now 150–215 ms, not
	 * 60–130, and the gesture inside it has its own floor (`FAST_TOUCH.gestureFloorMs`). Kept under
	 * `TELEMETRY_BANDS.holdTime.minMs` at every own urgency (≥ `ownBaseUrgency`), so a race move
	 * stays distinguishable from a normal one in the export. The hold system (`SCRAMBLE_HOLD`)
	 * carries the reaction part of a scramble.
	 */
	moveMinMs: [240, 150],
	moveMaxMs: [305, 215],
	/** Opponent-only pressure stays brisk without using our own emergency gesture timings. */
	opponentMoveMinMs: [500, 300],
	opponentMoveMaxMs: [850, 550],
	searchMaxMs: [100, 30],
	remainingClockFraction: 0.25,
	minimumWindowMs: 60,
} as const;

/** Appendix D §3a.3 time-pressure compression. */
export const COMPRESSION = {
	clockS: 30,
	pressure: 0.2,
	floor: 0.35,
	panicClockS: 12,
	panicFloor: 0.15,
	incFloorIncS: 2,
	incFloorClockS: 5,
	incFloor: 0.6,
} as const;

/** Hard caps: `0.5·C`; `0.15·C` if `C < 30 && inc < 2`; `0.35 s` if `C < 3`. */
export const CAPS = {
	fraction: 0.5,
	lowFraction: 0.15,
	lowClockS: 30,
	lowIncS: 2,
	tinyClockS: 3,
	tinyCapS: 0.35,
	/** A binding cap lands in `cap · U(jitterMin, 1)` rather than exactly at the cap (§8.4a). */
	jitterMin: 0.75,
} as const;

/** §8.4a guards. */
export const MIN_NORMAL_MS = 250;

/** Appendix D §5 re-plan rules. */
export const REPLAN = {
	clockJumpThresholdMs: 1500,
	blurReorientS: [0.3, 1.2],
	blurPauseThresholdS: 2,
	blurMinClockS: 15,
	/**
	 * §8.5 emergency: `myClockMs < emergencyClockMs` → every wait 0, minimal motor. The
	 * plan-level emergency regime (`boundByCap`) applies when EITHER that holds OR the floors
	 * (`minNormalMs` for normal/long moves; `orientation.minMs + motor.minMotorMs` for every
	 * non-premove window) cannot fit under the hard cap (`lo ≥ 1`): then no floor applies, the
	 * total is `cap · U(jitterMin, 1)` and the phases compress below their floors with the
	 * motor kept ≥ `minMotorMs`. There is no separate clock threshold for it.
	 */
	emergencyClockMs: 1500,
	observeShiftClamp: 2,
} as const;
