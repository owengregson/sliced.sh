import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { STRENGTH_LABEL_BANDS, type StrengthBand } from "@core/constants/ui";
import { COPY } from "../copy";
import type { SliderThreshold } from "./slider";

/**
 * The strength controls' one division (owner, 2026-09-15): the Maia cutoff, which is also where
 * the engine switches to the full network (`MAIA.eloMax`). The Settings slider and the Live
 * popover draw only this divider — no second marker.
 */
export const STRENGTH_NETWORK_THRESHOLD: SliderThreshold = {
	value: MAIA.eloMax,
	label: COPY.strength.networkCutoff(MAIA.eloMax),
	lowerLabel: COPY.strength.smallNetwork,
	upperLabel: COPY.strength.largeNetwork,
	description: COPY.strength.networkDescription(MAIA.eloMax, LIMITS.eloMax),
};

/** Strength band for a rating (Appendix F §7.2): the last `STRENGTH_LABEL_BANDS` floor it reaches. */
export function strengthBand(elo: number): StrengthBand {
	let band: StrengthBand = STRENGTH_LABEL_BANDS[0].band;
	for (const b of STRENGTH_LABEL_BANDS) if (elo >= b.min) band = b.band;
	return band;
}

/** "Club" — the category name for a rating. */
export function strengthBandLabel(elo: number): string {
	return COPY.strength.bands[strengthBand(elo)];
}

/** "Club 1200" — the slider bubble and `aria-valuetext`. */
export function strengthLabel(elo: number): string {
	return `${strengthBandLabel(elo)} ${elo}`;
}
