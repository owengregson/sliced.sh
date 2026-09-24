/**
 * tools/timing/clock-reference/buckets.ts — the §2.2 clock-fraction buckets of
 * `docs/research/chessmimic-bands-and-the-clock-2026-09-13.md` and the think-time statistics
 * reported per bucket.
 */

import type { Think } from "../../lib/pgn/thinks";
import { percentile } from "../../lib/stats";

export interface BucketSpec {
	label: string;
	/** Inclusive upper edge of the fraction (the first bucket's upper edge is 1, the start). */
	from: number;
	/** Exclusive lower edge of the fraction (the last bucket's is 0). */
	to: number;
}

/** The §2.2 buckets: the fraction of the starting clock still on that player's own clock. */
export const BUCKETS: readonly BucketSpec[] = [
	{ label: "1.00-0.85", from: 1, to: 0.85 },
	{ label: "0.85-0.55", from: 0.85, to: 0.55 },
	{ label: "0.55-0.25", from: 0.55, to: 0.25 },
	{ label: "0.25-0.00", from: 0.25, to: 0 },
] as const;

export interface BucketStats {
	n: number;
	meanS: number;
	medianS: number;
	shareUnder1s: number;
	shareUnder2s: number;
	shareOver10s: number;
	/** p5, p10, p20 … p90, p95 in seconds — the shape, not just the level. */
	percentiles: Record<string, number>;
}

const PERCENTILES = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95] as const;

export const round = (x: number, places: number): number =>
	Number.isFinite(x) ? Number(x.toFixed(places)) : x;

/**
 * The bucket a clock fraction falls in. Both edges are inclusive and the buckets are tried from
 * the top, so a think made with exactly 0.55 of the base clock is the *slow* end of `0.85-0.55`
 * rather than the fast end of `0.55-0.25` — the convention the §2.2 table was measured with
 * (it is worth one row per side in this corpus).
 */
export function bucketOf(fraction: number): string | null {
	for (const b of BUCKETS) if (fraction <= b.from && fraction >= b.to) return b.label;
	return null;
}

export function statsOf(values: number[]): BucketStats {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	const share = (predicate: (x: number) => boolean): number =>
		n === 0 ? Number.NaN : round(sorted.filter(predicate).length / n, 4);
	const percentiles: Record<string, number> = {};
	for (const p of PERCENTILES) percentiles[`p${p}`] = round(percentile(sorted, p), 2);
	return {
		n,
		meanS: round(n === 0 ? Number.NaN : sorted.reduce((a, b) => a + b, 0) / n, 2),
		medianS: round(percentile(sorted, 50), 2),
		shareUnder1s: share((x) => x < 1),
		shareUnder2s: share((x) => x < 2),
		shareOver10s: share((x) => x > 10),
		percentiles,
	};
}

/** Every think of the side, pooled. */
export const OVERALL = "overall";
/**
 * The two middle buckets together — the part of the game the long-think share is asserted over.
 * Pooling the *whole* game there is misleading: a simulated game keeps playing on a nearly empty
 * clock long after a real one has ended, and the sub-second moves that adds swamp the share.
 */
export const MIDDLEGAME_FROM = BUCKETS[1]?.from ?? 0;
export const MIDDLEGAME_TO = BUCKETS[2]?.to ?? 0;
export const MIDDLEGAME = `${MIDDLEGAME_FROM.toFixed(2)}-${MIDDLEGAME_TO.toFixed(2)}`;

export function bucketedStats(thinks: Think[]): Record<string, BucketStats> {
	const byBucket = new Map<string, number[]>();
	for (const b of BUCKETS) byBucket.set(b.label, []);
	for (const t of thinks) {
		const label = bucketOf(t.fraction);
		if (label) byBucket.get(label)?.push(t.thinkS);
	}
	const out: Record<string, BucketStats> = {
		[OVERALL]: statsOf(thinks.map((t) => t.thinkS)),
		[MIDDLEGAME]: statsOf(
			thinks
				.filter((t) => t.fraction <= MIDDLEGAME_FROM && t.fraction >= MIDDLEGAME_TO)
				.map((t) => t.thinkS)
		),
	};
	for (const [label, values] of byBucket) out[label] = statsOf(values);
	return out;
}
