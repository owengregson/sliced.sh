/**
 * ChessMimic per-band scalers (Task 34; Appendix J §B item 2). `scalers.json` is the upstream
 * `scalers.pkl` of every registered band (mean/std of the rating and of
 * `log(clock + 1)` for the player clock, opponent clock and increment), unpickled by
 * `tools/data/08_export_chessmimic.py`; it is imported at build time so the bundles carry it.
 *
 * `standardiseInputs` is the exact preprocessing the fixture was generated with. The rating is
 * clamped to the band's own range first: a band's rating std is ≈ 27 Elo, so a target 300 Elo
 * away would be a z-score of ≈ 11 — far outside anything the band model saw. Upstream never
 * extrapolates because its 14 bands are contiguous; with three shipped bands the nearest band
 * answers for its edge.
 */

import type { ChessMimicBand } from "@core/constants/models";
import scalersJson from "../../../assets/models/chessmimic/scalers.json" with { type: "json" };

export interface Scaler {
	mean: number;
	std: number;
}

/** Shape of one band's entry (`scalers.pkl` keys). */
export interface BandScalers {
	rating: Scaler;
	log_player_clock: Scaler;
	log_opponent_clock: Scaler;
	log_increment: Scaler;
}

export const CHESSMIMIC_SCALERS: Readonly<Record<ChessMimicBand, BandScalers>> = scalersJson;

/** The raw values the service worker sends; standardised where the band is finally chosen. */
export interface RawTimingInputs {
	band: string;
	rating: number;
	playerClockS: number;
	opponentClockS: number;
	incrementS: number;
}

export interface StandardisedInputs {
	scaledRating: number;
	/** `[log(player+1), log(opp+1), log(inc+1)]` standardised with the band scalers. */
	clockFeatures: [number, number, number];
}

/** `<lo>_<hi>` → `[lo, hi]`. */
export function bandRange(band: string): [number, number] {
	const [lo, hi] = band.split("_").map(Number);
	if (lo === undefined || hi === undefined || !Number.isFinite(lo) || !Number.isFinite(hi))
		throw new RangeError(`chessmimic band: malformed name "${band}"`);
	return [lo, hi];
}

export function bandCentre(band: string): number {
	const [lo, hi] = bandRange(band);
	return (lo + hi) / 2;
}

export function scalersFor(
	band: string,
	table: Readonly<Record<string, BandScalers>> = CHESSMIMIC_SCALERS
): BandScalers | undefined {
	return Object.hasOwn(table, band) ? table[band] : undefined;
}

function standardise(x: number, s: Scaler): number {
	return (x - s.mean) / (s.std || 1);
}

export function standardiseInputs(
	inputs: RawTimingInputs,
	scalers: BandScalers | undefined = scalersFor(inputs.band)
): StandardisedInputs {
	if (!scalers) throw new RangeError(`chessmimic scalers: no scalers for band "${inputs.band}"`);
	const [lo, hi] = bandRange(inputs.band);
	const rating = Math.min(hi, Math.max(lo, inputs.rating));
	return {
		scaledRating: standardise(rating, scalers.rating),
		clockFeatures: [
			standardise(Math.log(inputs.playerClockS + 1), scalers.log_player_clock),
			standardise(Math.log(inputs.opponentClockS + 1), scalers.log_opponent_clock),
			standardise(Math.log(inputs.incrementS + 1), scalers.log_increment),
		],
	};
}
