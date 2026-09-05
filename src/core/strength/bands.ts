/**
 * Appendix E §1.6 agreement band lookup (Task 24): the band whose knot is the highest at or
 * below the target Elo (flat outside the table), and whether a running top-1 % / ACPL pair sits
 * inside it. Pure; the session strip and the conformance report share it.
 */

import { AGREEMENT_BANDS, type AgreementBand } from "./constants";

export function bandFor(targetElo: number): AgreementBand {
	let band: AgreementBand = AGREEMENT_BANDS[0];
	for (const b of AGREEMENT_BANDS) if (targetElo >= b.elo) band = b;
	return band;
}

export interface BandCheck {
	band: AgreementBand;
	top1InBand: boolean;
	acplInBand: boolean;
	inBand: boolean;
}

/** `undefined` stats (no move yet) count as in band. */
export function checkBand(
	targetElo: number,
	stats: { top1Pct?: number | undefined; acpl?: number | undefined }
): BandCheck {
	const band = bandFor(targetElo);
	const top1InBand =
		stats.top1Pct === undefined || (stats.top1Pct >= band.top1[0] && stats.top1Pct <= band.top1[1]);
	const acplInBand =
		stats.acpl === undefined || (stats.acpl >= band.acpl[0] && stats.acpl <= band.acpl[1]);
	return { band, top1InBand, acplInBand, inBand: top1InBand && acplInBand };
}
