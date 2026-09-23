/** Preview selections (§9.3a) and the right-button line preview. */

import type { PersonaId } from "@typedefs/settings";
import type { MsRange } from "../types";

/**
 * §9.3a preview-selection model: `p_preview = clamp(base · f · g · scale, 0, cap)` —
 * the settings scale is applied BEFORE the cap (ruling), so `scale > 1` cannot exceed it.
 */
export const PREVIEW = {
	base: { cautious: 0.04, balanced: 0.07, aggressive: 0.1, blitz: 0.05 } satisfies Record<
		PersonaId,
		number
	>,
	/** f = 1 + fSlope·(n_reasonable − 1). */
	fSlope: 0.35,
	/** g ramp: 0 below `gZeroMs`, 1 at `gOneMs`, `gMaxValue` at `gMaxMs`. */
	gZeroMs: 1200,
	gOneMs: 4000,
	gMaxMs: 10_000,
	gMaxValue: 1.6,
	cap: 0.35,
	clockFloorMs: 15_000,
	secondPreviewFactor: 0.25,
	differentPieceProb: 0.8,
	/** Resolve by switching selection (else click an empty square first). */
	switchProb: 0.8,
	dragStyleProb: 0.35,
	dwellMs: [300, 1200] as MsRange,
	dragDisplacementPx: [8, 40] as MsRange,
	/** Drag previews release within this distance of the press, inside the origin square. */
	dragReturnSigmaPx: 3,
	/** Design prior: reconsider at the excursion before returning, within the preview budget. */
	dragReconsiderMs: [180, 480] as MsRange,
	/** Keep every held preview point inside its origin, including during cancellation. */
	dragBoundaryPadPx: 1,
	/** Target rect for the outbound leg of a drag preview. */
	dragTargetRectPx: 6,
	/** Deselect squares within this king-distance of the piece are preferred. */
	deselectMaxDistance: 3,
	/** Time reserved for the preview before the scan phase spends the budget. */
	reserveMs: 2200,
} as const;

/**
 * The line preview (owner, 2026-09-12): on a long think the hand occasionally maps out the line it
 * is considering the way a player previews a sequence before moving — a **right-button** drag from
 * the from-square to the to-square for each ply of the chosen move's PV (our move, their reply,
 * our next move …), which chess.com renders as an arrow, with a human pause between arrows and a
 * longer look at the finished line; now and then a second line (an alternative candidate's PV)
 * after a pause. The move's own left press then clears every arrow on the site. Planned by
 * `src/core/motor/line-preview.ts`, drawn by the hand inside the decision phase.
 *
 * Every number of that gesture lives here (C1). Durations are `[lo, hi]` ms ranges sampled
 * uniformly per arrow / per line from the preview's own seeded stream.
 */
export const LINE_PREVIEW = {
	/** Only a think planned at least this long gets a preview (≈ 6 s: the gesture itself is seconds). */
	minThinkMs: 6000,
	/** The same clock floor as the §9.3a previews: nobody annotates in time trouble. */
	minClockMs: PREVIEW.clockFloorMs,
	/**
	 * Plies of the line drawn: sampled in this range, clipped to the PV's legal length (owner,
	 * 2026-09-12: "aim for 3–7 plies of play"). The fit loop shortens a line the window cannot hold.
	 */
	plies: [3, 7] as MsRange,
	/**
	 * "Prioritize pieces that are doing something active near the piece that was just moved": a
	 * line's activity is the number of its plies whose from- or to-square lies within `nearRadius`
	 * (Chebyshev) of the opponent's last-moved piece. Alternatives are drawn with weight
	 * `1 + nearWeight · activity`, and a second line is more likely when an active one exists.
	 */
	nearRadius: 2,
	nearWeight: 2.5,
	nearSecondLineProb: 0.55,
	/**
	 * P(preview | eligible) by planned think time — `[thinkMs, p]` knots, linear between, flat
	 * beyond the ends. Rises with the think: a 6 s think previews rarely, a 20 s think half the time.
	 */
	probability: [
		[6000, 0.12],
		[10_000, 0.3],
		[20_000, 0.5],
	] as ReadonlyArray<readonly [number, number]>,
	/** A second line (another candidate's PV, first ply different) follows the first this often. */
	secondLineProb: 0.25,
	/** Hard per-game cap on moves that get a preview, so it stays an occasional thing. */
	maxPerGame: 6,
	/** Pause between two arrows of one line (the eye moving to the next piece). */
	betweenArrowsMs: [350, 1100] as MsRange,
	/** Looking at the finished line before anything else happens. */
	afterLineMs: [700, 1800] as MsRange,
	/** Pause before a second line is started. */
	betweenLinesMs: [500, 1400] as MsRange,
	/** Pause on the from-square before the right button goes down. */
	prePressMs: [30, 110] as MsRange,
	/** Right button held still before the drag sets off (shorter than a piece grab: nothing is picked up). */
	pressToDragMs: [40, 140] as MsRange,
	/** Settle over the to-square before the right button comes up. */
	releaseSettleMs: [30, 120] as MsRange,
	/** The hand rests after the last arrow before the approach begins (part of the decision pause). */
	restBeforeApproachMs: [250, 700] as MsRange,
	/**
	 * Budget margin: the whole gesture (estimated from the profile's Fitts times plus the sampled
	 * pauses) must fit inside the window's scan + preview + decision phases with this much to
	 * spare, so the decision pause never collapses and the approach starts on time. The planner
	 * charges the estimate against the exploration budget (fewer hovers on a previewed move).
	 */
	marginMs: 600,
	/** Per-leg allowance on top of the Fitts estimate for the path generator's overshoots/corrections. */
	travelAllowanceMs: 150,
} as const;
