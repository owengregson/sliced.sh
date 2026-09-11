import { QUALITY_STATISTICS as Q } from "@core/constants/telemetry";
import type { SessionQualitySample } from "@typedefs/game";
import { bandFor } from "./bands";
import type { AgreementBand } from "./constants";

type Interval = readonly [number, number];
export interface QualityBandCheck {
	band: AgreementBand;
	state: "inside" | "outside" | "uncertain" | "insufficient";
	top1Interval: Interval | null;
	lossInterval: Interval | null;
}

/**
 * Approximate noise guard, not an Elo calibration or guaranteed confidence coverage:
 * chess choices are correlated. Wilson handles a small binomial agreement sample; a
 * conservative t-style standard-error interval describes the observed loss variation.
 */
export function checkQualityBand(
	targetElo: number,
	sample: Partial<SessionQualitySample>
): QualityBandCheck {
	const band = bandFor(targetElo);
	const n = sample.scoredMoves ?? 0;
	if (
		!Number.isInteger(n) ||
		n < Q.minGameMoves ||
		!Number.isFinite(sample.top1Pct) ||
		!Number.isFinite(sample.acpl) ||
		(sample.top1Pct ?? -1) < 0 ||
		(sample.top1Pct ?? 101) > 100 ||
		(sample.acpl ?? -1) < 0 ||
		!Number.isFinite(sample.lossM2) ||
		(sample.lossM2 ?? -1) < 0
	)
		return { band, state: "insufficient", top1Interval: null, lossInterval: null };
	const p = Math.max(0, Math.min(1, (sample.top1Pct ?? 0) / 100));
	const z2 = Q.wilsonZ ** 2;
	const denominator = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denominator;
	const radius = (Q.wilsonZ * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
	const top1Interval: Interval = [
		Math.max(0, center - radius) * 100,
		Math.min(1, center + radius) * 100,
	];
	const margin = Q.lossStandardErrors * Math.sqrt((sample.lossM2 ?? 0) / (n - 1) / n);
	const loss = sample.acpl ?? 0;
	const lossInterval: Interval = [Math.max(0, loss - margin), loss + margin];
	const misses = (interval: Interval, reference: Interval): boolean =>
		interval[1] < reference[0] || interval[0] > reference[1];
	const contained = (interval: Interval, reference: Interval): boolean =>
		interval[0] >= reference[0] && interval[1] <= reference[1];
	const outside = misses(top1Interval, band.top1) || misses(lossInterval, band.acpl);
	const inside = contained(top1Interval, band.top1) && contained(lossInterval, band.acpl);
	return {
		band,
		state: outside ? "outside" : inside ? "inside" : "uncertain",
		top1Interval,
		lossInterval,
	};
}
