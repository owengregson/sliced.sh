/**
 * Perceptual / orientation latency (§8.4b item 2): the time to register the
 * opponent's move and re-scan the board. `LN(median 380 ms, σ 0.35)`, longer
 * after a surprising move (`+0.4·swing_bad` in log space) and shorter for an
 * expected reply (`−0.25·ponder_hit`); never below 150 ms. Part of `thinkMs`.
 */

import type { Rng } from "@core/rng";
import { TIMING_CONSTANTS } from "./constants";
import { logNormal } from "./distributions";
import type { Features } from "./types";

const O = TIMING_CONSTANTS.orientation;

/** Median orientation latency for the position (no noise). */
export function orientationMedianMs(f: Pick<Features, "swing_bad" | "ponder_hit">): number {
	return O.medianMs * Math.exp(O.swingBad * f.swing_bad + O.ponderHit * f.ponder_hit);
}

export function sampleOrientationMs(
	f: Pick<Features, "swing_bad" | "ponder_hit">,
	rng: Rng
): number {
	return Math.max(O.minMs, logNormal(rng, orientationMedianMs(f), O.sigma));
}
