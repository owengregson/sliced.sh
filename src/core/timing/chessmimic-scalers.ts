/**
 * ChessMimic per-band scalers (Task 34; Appendix J §B item 2). `scalers.json` is the upstream
 * `scalers.pkl` of every registered band (mean/std of the rating and of
 * `log(clock + 1)` for the player clock, opponent clock and increment), unpickled by
 * `tools/data/08_export_chessmimic.py`; it is imported at build time so the bundles carry it.
 *
 * `standardiseInputs` is the exact preprocessing the fixture was generated with. The rating is
 * clamped to the band's own range first: a 100-Elo band's rating std is ≈ 27 Elo, so a target
 * 300 Elo away would be a z-score of ≈ 11 — far outside anything the band model saw. Upstream
 * never extrapolates because its 14 bands are contiguous; with five shipped bands the nearest
 * band answers for its edge.
 *
 * The clamp bounds the z-score only as far as the band is narrow. `2200_3500` is 1 300 Elo wide.
 * Upstream fitted it on a population of 2357 ± 126.7, which put a 3000 target at z = +5.07; the
 * shipped band is fine-tuned on chess.com movers rated 2100+ and its scaler refitted to that
 * population (2632.6 ± 280.1), so 3000 is z = +1.31 and 3500 z = +3.10 (`docs/models.md` §9).
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

/**
 * The rating a band is *about*: the mean of the population it was trained on (`scalers.json`
 * `rating.mean`), falling back to the arithmetic midpoint of its name for a band with no scalers.
 *
 * The two agree to within a couple of Elo for the 100-wide bands (1200–1300's population mean is
 * 1251.9 against a midpoint of 1250) and disagree completely for the wide top band: `2200_3500`'s
 * midpoint is 2850, its population mean 2632.6 (upstream's, before the fine-tune: 2357.1).
 * Nearest-*midpoint* selection therefore sent every target from 2200 to 2450 — inside that
 * band's own range — to `2000_2100` instead, where
 * `standardiseInputs` clamped it to 2100. The owner plays at 2400–2450, so the band added on
 * 2026-09-13 to stop a 2400 being modelled as a 1900 would have modelled it as a 2100
 * (docs/research/chessmimic-bands-and-the-clock-2026-09-13.md). The population mean is what
 * "nearest band" was always trying to say.
 */
export function bandCentre(
	band: string,
	table: Readonly<Record<string, BandScalers>> = CHESSMIMIC_SCALERS
): number {
	const mean = scalersFor(band, table)?.rating.mean;
	if (mean !== undefined && Number.isFinite(mean)) return mean;
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
