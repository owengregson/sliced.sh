/**
 * The physical side of a plan: fake-out, the Appendix D §3a.6 motor model, orientation latency
 * and window allocation.
 */

/** Hesitation fake-out (motor), `p = pBase + pElo·(1 − elo_z)`, only when `C > minClockS`. */
export const FAKEOUT = {
	pBase: 0.02,
	pElo: 0.015,
	holdMs: [250, 700],
	gapMs: [300, 900],
	minClockS: 20,
} as const;

/** Appendix D §3a.6 motor model. */
export const MOTOR = {
	hoverMedianS: 0.22,
	hoverSigma: 0.35,
	dragBaseS: 0.09,
	dragLogS: 0.07,
	dragSdS: 0.03,
	dragMinS: 0.08,
	dragMaxS: 0.6,
	clickBaseS: 0.12,
	clickLogS: 0.05,
	promoS: [0.25, 0.6],
	/** Floor when `t_total < t_motor` (premove: 0). */
	minMotorMs: 60,
} as const;

/** §8.4b item 2 orientation latency. */
export const ORIENTATION = {
	medianMs: 380,
	sigma: 0.35,
	swingBad: 0.4,
	ponderHit: -0.25,
	minMs: 150,
} as const;

/** §8.4b item 3 window allocation. */
export const WINDOW = {
	decisionMin: 0.15,
	decisionMax: 0.4,
	/** Share of the exploration budget spent on preview selections when the window has one. */
	previewShare: 0.25,
} as const;

/**
 * An anticipated reply (2026-09-24): the idle hand rested on the answering piece
 * (`TimingContext.hoverSquare`) and the move is that piece's expected answer (the pondered reply
 * or a recapture). A sampled think up to `maxThinkFactor` × the anticipated execution keeps the
 * hand on the piece — reaction, grasp, carry (`anticipatedExecution`), the rest spent holding;
 * a longer one is an ordinary think and the hand leaves to scan.
 */
export const ANTICIPATED = { maxThinkFactor: 2 } as const;
