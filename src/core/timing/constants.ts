/**
 * `TIMING_CONSTANTS` — Appendix D §7 (default parameter table) plus the §8 /
 * §8.4b constants, transcribed ONCE (C1). Every number of the timing model
 * lives here; the modules under `src/core/timing/` only read it.
 *
 * Elo-dependent parameters are `[p0, p1]` pairs: `p(e) = p0 + p1·elo_z`.
 *
 * Each domain lives in its own module under `./constants/`; this object is the one table of
 * contents the timing modules read.
 */

import { BUDGET, MOVE_BUDGET, RATING_PACE } from "./constants/budget";
import { CHESSMIMIC } from "./constants/chessmimic";
import {
	CAPS,
	CLOCK_RACE,
	COMPRESSION,
	MIN_NORMAL_MS,
	OPPONENT_PRESSURE,
	REPLAN,
} from "./constants/clock";
import { ANTICIPATED, FAKEOUT, MOTOR, ORIENTATION, WINDOW } from "./constants/execution";
import { FEATURES, UNTIMED_VIRTUAL } from "./constants/features";
import { BOT_PACE, BOT_PACE_FLOOR, PERSONA } from "./constants/persona";
import {
	BETA,
	INSTANT,
	KNOBS,
	LONG_THINK,
	PHI,
	PREMOVE,
	SIGMA,
	TILT,
	V2_MLP,
} from "./constants/v1-head";

export type { ProfileOffsets } from "./constants/persona";

export const TIMING_CONSTANTS = {
	features: FEATURES,
	untimedVirtual: UNTIMED_VIRTUAL,
	budget: BUDGET,
	ratingPace: RATING_PACE,
	moveBudget: MOVE_BUDGET,
	opponentPressure: OPPONENT_PRESSURE,
	clockRace: CLOCK_RACE,
	beta: BETA,
	sigma: SIGMA,
	phi: PHI,
	compression: COMPRESSION,
	caps: CAPS,
	premove: PREMOVE,
	instant: INSTANT,
	longThink: LONG_THINK,
	tilt: TILT,
	fakeout: FAKEOUT,
	anticipated: ANTICIPATED,
	motor: MOTOR,
	persona: PERSONA,
	orientation: ORIENTATION,
	window: WINDOW,
	minNormalMs: MIN_NORMAL_MS,
	botPaceFloor: BOT_PACE_FLOOR,
	botPace: BOT_PACE,
	replan: REPLAN,
	chessmimic: CHESSMIMIC,
	v2Mlp: V2_MLP,
	knobs: KNOBS,
} as const;
