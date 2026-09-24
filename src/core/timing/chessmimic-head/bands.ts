/** Which ChessMimic band answers a rating. */
import type { ChessMimicBand } from "@core/constants/models";
import { CHESSMIMIC_BUCKETS } from "../chessmimic-buckets";
import { bandCentre, bandRange } from "../chessmimic-scalers";
import { TIMING_CONSTANTS } from "../constants";

export const CHESSMIMIC_BANDS: readonly ChessMimicBand[] = TIMING_CONSTANTS.chessmimic.bands;

/** Prefer a model trained on the requested rating; nearest population mean fills only gaps. */
export function selectBand(targetElo: number): ChessMimicBand {
	for (const band of CHESSMIMIC_BANDS) {
		const [low, high] = bandRange(band);
		if (targetElo >= low && targetElo <= high) return band;
	}
	let best: ChessMimicBand = CHESSMIMIC_BANDS[0] ?? "1500_1600";
	let bestDist = Number.POSITIVE_INFINITY;
	for (const band of CHESSMIMIC_BANDS) {
		const d = Math.abs(targetElo - bandCentre(band));
		if (d < bestDist) {
			bestDist = d;
			best = band;
		}
	}
	return best;
}

export function isRegisteredBand(band: string): band is ChessMimicBand {
	return Object.hasOwn(CHESSMIMIC_BUCKETS, band);
}
