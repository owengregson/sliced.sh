/**
 * tools/timing-calibration/sim/latency.ts — the latency model: the parts of the release path no
 * browser measured for us (transport, preparation overheads, the arming searches) and the hand's
 * numbers from the `hover` executor simulation, plus chess.com's tenth-second recording.
 */

import type { Rng } from "@core/rng";

export const LATENCY = {
	/** Page → service worker on arrival plus CDP release → page: an assumption (the hover sim has none). */
	transportMs: 30,
	/** A search's stop receipt and the pipeline's bookkeeping after its deadline. */
	prepOverheadMs: 25,
	/** A pre-analysed (cache-hit) own move: policy and bookkeeping only. */
	hitPrepMs: 40,
	/** The two arming searches (`PREMOVE.ponderMovetimeMs + replyMovetimeMs`) after our move lands. */
	armMs: 340,
	/** Harvesting the ponder's prediction when nothing was armed. */
	harvestMs: 60,
	/**
	 * The hand's natural touch when a plan is late (`hover`, 60 seeds at 2700): p10/p50/p90
	 * 383/453/539 ms from rest, 334/403/497 ms with the hand hovering on the piece. Log-normal.
	 */
	naturalMs: { median: 453, sigma: 0.135 },
	naturalHoverMs: { median: 403, sigma: 0.16 },
	/** `fireOnReply` arrival → release, measured by `hover` (n = 13): the empirical sample. */
	fireMs: [118, 118, 120, 248, 248, 253, 321, 321, 335, 344, 351, 405, 442],
	/** Gesture of a queued premove's drag (`FAST_TOUCH.gestureFloorMs` and the carry). */
	queueGestureMs: 180,
} as const;

export function recordedMs(releaseMs: number): number {
	return Math.max(100, Math.ceil(releaseMs / 100 - 1e-9) * 100);
}

export function logNormalMs(rng: Rng, p: { median: number; sigma: number }): number {
	return p.median * Math.exp(rng.normal(0, p.sigma));
}
