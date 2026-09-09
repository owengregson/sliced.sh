// test/sim/telemetry/constants.ts
/**
 * Test-only numbers of the telemetry harness (Task 33), once. Every §13 band
 * lives in `TELEMETRY_BANDS` (`src/core/constants/telemetry.ts`); this file
 * holds only the simulated site's geometry, the scripted opponent and the
 * fake evaluation lines the harness feeds the timing model.
 */

import { CLICK, MIN_JERK, MOTOR_DEFAULTS, PATH, PROFILE_NOISE } from "@core/motor/constants";

/** Viewport rect of the simulated board (a 640 px chess.com-sized board). */
const BOARD = { left: 100, top: 60, size: 640 } as const;
/** Where the real mouse rested before auto-play was armed (off the board). */
const REST_POINT = { x: 900, y: 400 } as const;

/** Both profile jitters at their upper clamp — the widest a sampled motor range gets. */
const MAX_PROFILE_STRETCH = (1 + PROFILE_NOISE.perGameOffset) * (1 + PROFILE_NOISE.perMoveClamp);

/** The longest straight line the hand can travel: the diagonal of the board plus its rest point. */
const MAX_TRAVEL_PX = Math.hypot(
	Math.max(BOARD.left + BOARD.size, REST_POINT.x) - Math.min(BOARD.left, REST_POINT.x),
	Math.max(BOARD.top + BOARD.size, REST_POINT.y) - Math.min(BOARD.top, REST_POINT.y)
);
/** The longest drag: corner to corner of the board. */
const BOARD_DIAGONAL_PX = Math.hypot(BOARD.size, BOARD.size);
const SQUARE_PX = BOARD.size / 8;

/**
 * `path-generator.ts:fittsMs` at the profile's nominal parameters (no jitter): the Shannon-form
 * movement time for `distPx` onto a `widthPx` target, floored by the speed cap.
 */
function nominalFittsMs(distPx: number, widthPx: number): number {
	const m = MOTOR_DEFAULTS;
	const id = Math.log2(distPx / Math.max(PATH.minWidthPx, widthPx) + 1);
	const mt = (m.fittsA + m.fittsB * id) * 1000 * m.travelSpeedScale;
	const capFloor =
		((MIN_JERK.peakSpeedFactor * distPx) / (m.peakSpeedCapPxPerS * PATH.capHeadroom)) * 1000;
	return Math.max(mt, capFloor);
}

/**
 * Plausibility ceiling for one whole touch (approach → grab → drag → drop) on this board,
 * derived from the motor profile rather than guessed: the two Fitts movements the hand makes
 * — the longest approach (`MAX_TRAVEL_PX` onto one square) and the longest drag (the board
 * diagonal) — at the per-move jitter ceiling (`PATH.fittsJitter[1]`), plus the grab and drop
 * pauses at their own sampled ceilings. This is a plausibility scale that tracks the profile,
 * NOT a hard upper bound: the per-move jitter is applied to the Fitts terms but the persona and
 * time-control multipliers, the overshoot branch and the hesitation pauses are not modelled, so
 * a legitimate touch can exceed it on a slow persona. It exists to catch a generator that has
 * come off its profile entirely, and it moves with `MOTOR_DEFAULTS`/`PATH` instead of freezing
 * a literal. (Measured max over the 200-move timing-shape run: 2148 ms.)
 */
const MAX_TOUCH_MS = Math.ceil(
	(nominalFittsMs(MAX_TRAVEL_PX, SQUARE_PX) + nominalFittsMs(BOARD_DIAGONAL_PX, SQUARE_PX)) *
		PATH.fittsJitter[1] +
		CLICK.preGrabPauseMs[1] +
		MOTOR_DEFAULTS.grabDelayMs[1] * MAX_PROFILE_STRETCH +
		PATH.grabWobble.points[1] * PATH.grabWobble.dtMs[1] +
		MOTOR_DEFAULTS.releaseSettleMs[1] * MAX_PROFILE_STRETCH
);

export const SIM_TELEMETRY = {
	board: BOARD,
	restPoint: REST_POINT,
	/** Virtual-clock start of every harness run (ms epoch). */
	startAt: 1_000_000,
	/** The scripted bot opponent replies after this much think time (uniform, ms). */
	opponentThinkMs: [400, 1500] as readonly [number, number],
	/** A `focus` port message reaches the service worker within this (ms of virtual time). */
	portHopMaxMs: 5,
	/** Pause before a fresh move window opens again after a focus skip (ms). */
	refocusPauseMs: 800,
	/** Fake MultiPV lines: best line cp, spacing of the reasonable lines, offset of the rest. */
	lines: { count: 4, bestCp: 20, reasonableStepCp: 10, unreasonableCp: 150, depth: 12 },
	/** `n_reasonable` is drawn uniformly from 1..maxReasonable per move. */
	maxReasonable: 4,
	/** Default game: rapid 10+0 against a bot, 1650 target, the balanced persona. */
	game: { baseSec: 600, incSec: 0, targetElo: 1650, persona: "balanced", tcClass: "rapid" },
	/** Clock left at the start of a "time-pressure" game (§8 compression regime). */
	pressureStartMs: 60_000,
	/**
	 * A move counts as "dropped on the planned deadline" when the page's `MoveHoldTime`
	 * is within this of the plan's `thinkMs` (ms). Beyond it the hand overran, which the
	 * executor only allows when the natural motor time alone exceeded the think budget
	 * (`hand-controller.ts`: `approachStartAt = max(now, t0 + think − approach − touch)`).
	 */
	deadlineToleranceMs: 150,
	maxTouchMs: MAX_TOUCH_MS,
	/** The approach starting this early into the window means the pre-touch phases collapsed (ms). */
	collapsedPreTouchMs: 1,
	/** Slack for comparing two times the virtual clock computed by different float paths (ms). */
	clockEpsilonMs: 0.001,
	/** The driver steps the virtual clock by this much while a move runs (ms). */
	advanceStepMs: 25,
	/** Longest the harness lets the virtual clock run for one move (a move never outlasts the base time). */
	maxMoveAdvanceMs: 600_000,
	/** Number of moves in the reference bot game (Step 2a) and the timing-shape run (Step 2f). */
	referenceGameMoves: 30,
	timingShapeMoves: 200,
	/** Games of the timing-shape run: comfortable clocks first, then time-pressure games. */
	timingShapeGames: { comfortable: 3, pressure: 2, movesPerGame: 40 },
	/**
	 * The pooled preview-rate population (Step 2a band): enough seeded games that the
	 * non-trivial moves clear `TELEMETRY_BANDS.multiSelect.minMovesForBand` — ~23 of the
	 * 30 moves of a rapid game are preview-eligible, so 12 games give ≈ 276.
	 */
	previewPool: { games: 12, movesPerGame: 30 },
	/**
	 * The `chrome.commands` / keybind rows (Step 1) fire the shortcut on the first `normal`
	 * move whose planned think is at least `minThinkMs` — long enough that the control run
	 * really does explore, so "the shortcut collapsed the window" is a measurable claim and
	 * not a no-op on a move that was instant anyway. The search runs over `searchMoves` moves
	 * and the test fails loudly if no such move turns up.
	 */
	shortcut: { minThinkMs: 5000, searchMoves: 12, maxHoldFraction: 0.5 },
} as const;
