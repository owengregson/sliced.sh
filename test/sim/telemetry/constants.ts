// test/sim/telemetry/constants.ts
/**
 * Test-only numbers of the telemetry harness (Task 33), once. Every §13 band
 * lives in `TELEMETRY_BANDS` (`src/core/constants/telemetry.ts`); this file
 * holds only the simulated site's geometry, the scripted opponent and the
 * fake evaluation lines the harness feeds the timing model.
 */

export const SIM_TELEMETRY = {
	/** Viewport rect of the simulated board (a 640 px chess.com-sized board). */
	board: { left: 100, top: 60, size: 640 },
	/** Where the real mouse rested before auto-play was armed (off the board). */
	restPoint: { x: 900, y: 400 },
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
	/**
	 * Plausibility ceiling for one whole touch (approach → grab → drag → drop) on the
	 * simulated 640 px board: a longer "hand movement" would be a generator bug, not a hand.
	 */
	maxTouchMs: 2500,
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
} as const;
