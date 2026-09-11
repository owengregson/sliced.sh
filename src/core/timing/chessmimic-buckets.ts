/**
 * ChessMimic clock buckets and decoding (Task 34; Appendix J §B items 1 and 7). `buckets.json`
 * is the upstream `clock_buckets.json` of every registered band: the 30 bucket edges (1-second
 * buckets to 27 s, then [27,32), [32,40), [40,∞)), the empirical prior and, per bucket, the
 * empirical distribution of integer think-time seconds inside it (`bucket_empirical_distributions`,
 * `seconds` for the finite buckets, `frequent_values` + `coverage` for the open one).
 *
 * Decoding a sampled bucket to seconds mirrors `sample_from_bucket_empirical` with two changes:
 *
 *   1. a Lichess `%clk` reading of `s` seconds means the true think time was in `[s, s+1)`, so
 *      the integer second drawn from the table gets U(0, 1) added — the 1-second buckets are
 *      therefore uniform inside their edges, the wide buckets follow their tables, and nothing
 *      lands on an exact second (no mass points, §13);
 *   2. the open bucket's table covers only ≈ 75 % of its mass (40–59 s), so the rest is drawn as
 *      (max table second + 1) + Exp(`openBucketTailMeanS`) with upstream's blitz tail mean,
 *      rather than being clipped to the table.
 */

import type { ChessMimicBand } from "@core/constants/models";
import type { Rng } from "@core/rng";
import bucketsJson from "../../../assets/models/chessmimic/buckets.json" with { type: "json" };
import { TIMING_CONSTANTS } from "./constants";
import { exponential, uniform } from "./distributions";

const CM = TIMING_CONSTANTS.chessmimic;

export interface EmpiricalDistribution {
	/** `"seconds"` (finite buckets) or `"frequent_values"` (open bucket). */
	type: string;
	/** Integer second (as a string key) → weight (percent; normalised on use). */
	distribution: Record<string, number>;
	/** Percent of the bucket's mass the table covers (open bucket only). */
	coverage?: number;
}

export interface BandBuckets {
	/** 31 edges; `null` is the open upper edge. */
	boundaries: Array<number | null>;
	n_buckets: number;
	scheme: string;
	time_control: string;
	bucket_probabilities: number[];
	bucket_empirical_distributions: EmpiricalDistribution[];
	statistics: Record<string, number>;
}

export const CHESSMIMIC_BUCKETS = bucketsJson as Readonly<Record<ChessMimicBand, BandBuckets>>;

function edgesOf(b: BandBuckets): number[] {
	return b.boundaries.map((e) => (e === null ? Number.POSITIVE_INFINITY : e));
}

function sharedBoundaries(): readonly number[] {
	const bands = Object.values(CHESSMIMIC_BUCKETS);
	const first = bands[0];
	if (!first) throw new RangeError("chessmimic buckets: no bands");
	const edges = edgesOf(first);
	if (edges.length !== CM.nBuckets + 1)
		throw new RangeError(`chessmimic buckets: ${edges.length - 1} buckets, expected ${CM.nBuckets}`);
	for (const b of bands) {
		const other = edgesOf(b);
		if (other.length !== edges.length || other.some((e, i) => e !== edges[i]))
			throw new RangeError("chessmimic buckets: bands disagree on the bucket edges");
	}
	return Object.freeze(edges);
}

/** Bucket edges shared by every band: `[0, 1, …, 27, 32, 40, ∞]`. */
export const CLOCK_BUCKET_BOUNDARIES: readonly number[] = sharedBoundaries();

/** `searchsorted(boundaries[:-1], t, "right") − 1`, clipped to `[0, n − 1]`. */
export function bucketIndexOf(seconds: number): number {
	for (let b = CM.nBuckets - 1; b >= 0; b--)
		if (seconds >= (CLOCK_BUCKET_BOUNDARIES[b] ?? 0)) return b;
	return 0;
}

/** Buckets whose lower edge is within `player_clock + increment`; bucket 0 always valid. */
export function bucketMask(playerClockS: number, incrementS: number): boolean[] {
	const maxValid = bucketIndexOf(Math.max(0, playerClockS + incrementS));
	return Array.from({ length: CM.nBuckets }, (_, b) => b === 0 || b <= maxValid);
}

/** Lowest temperature the bucket draw will use; shared so `maskedBucketShare` cannot drift from it. */
const TEMPERATURE_FLOOR = 1e-3;

/** Temperature-scaled weights over the valid buckets, and their total. */
function maskedWeights(
	probs: readonly number[],
	mask: readonly boolean[],
	temperature: number
): { items: number[]; weights: number[]; total: number } {
	const T = Math.max(TEMPERATURE_FLOOR, temperature);
	const items: number[] = [];
	const weights: number[] = [];
	let total = 0;
	for (let b = 0; b < CM.nBuckets; b++) {
		const p = probs[b] ?? 0;
		if (!mask[b] || !(p > 0)) continue;
		const w = p ** (1 / T);
		items.push(b);
		weights.push(w);
		total += w;
	}
	return { items, weights, total };
}

/**
 * The probability this draw lands in `bucket` — the same weighting `sampleBucket` uses, so the two
 * cannot drift apart (they share `maskedWeights`, which is what C1 wants of the temperature floor).
 * 0 when the bucket is masked out or carries no mass.
 */
export function maskedBucketShare(
	probs: readonly number[],
	mask: readonly boolean[],
	temperature: number,
	bucket: number
): number {
	const { items, weights, total } = maskedWeights(probs, mask, temperature);
	if (!(total > 0)) return 0;
	const at = items.indexOf(bucket);
	return at < 0 ? 0 : (weights[at] ?? 0) / total;
}

/** Temperature-scaled draw over the valid buckets; bucket 0 when nothing else has mass. */
export function sampleBucket(
	probs: readonly number[],
	mask: readonly boolean[],
	temperature: number,
	rng: Rng
): number {
	const T = Math.max(TEMPERATURE_FLOOR, temperature);
	const weights: number[] = [];
	const items: number[] = [];
	let total = 0;
	for (let b = 0; b < CM.nBuckets; b++) {
		const p = probs[b] ?? 0;
		if (!mask[b] || !(p > 0)) continue;
		const w = p ** (1 / T);
		weights.push(w);
		items.push(b);
		total += w;
	}
	if (items.length === 0 || !(total > 0)) return 0;
	return rng.weighted(items, weights);
}

interface BucketTable {
	seconds: number[];
	weights: number[];
	/** Fraction of the bucket's mass the table covers (1 for the finite buckets). */
	coverage: number;
	/** First second of the tail beyond the table (open bucket). */
	tailStartS: number;
}

const tableCache = new Map<string, BucketTable>();

function tableFor(band: ChessMimicBand, bucket: number): BucketTable {
	const key = `${band}:${bucket}`;
	const cached = tableCache.get(key);
	if (cached) return cached;
	const dist = CHESSMIMIC_BUCKETS[band]?.bucket_empirical_distributions[bucket];
	if (!dist) throw new RangeError(`chessmimic buckets: no table for ${band} bucket ${bucket}`);
	const seconds: number[] = [];
	const weights: number[] = [];
	for (const [k, w] of Object.entries(dist.distribution)) {
		seconds.push(Math.floor(Number(k)));
		weights.push(w);
	}
	const open = !Number.isFinite(CLOCK_BUCKET_BOUNDARIES[bucket + 1] ?? Number.NaN);
	const coverage = open ? Math.min(1, Math.max(0, (dist.coverage ?? 100) / 100)) : 1;
	const table = { seconds, weights, coverage, tailStartS: Math.max(...seconds) + 1 };
	tableCache.set(key, table);
	return table;
}

/** Continuous seconds inside `bucket`: empirical integer second + U(0, 1), or the open tail. */
export function sampleWithinBucket(band: ChessMimicBand, bucket: number, rng: Rng): number {
	const t = tableFor(band, bucket);
	if (t.coverage < 1 && rng.next() >= t.coverage)
		return t.tailStartS + exponential(rng, CM.openBucketTailMeanS);
	const second = t.seconds.length === 1 ? (t.seconds[0] ?? 0) : rng.weighted(t.seconds, t.weights);
	return second + uniform(rng, 0, 1);
}

/**
 * Mean seconds of what `sampleWithinBucket` actually draws — the band's empirical table mean
 * (each second + the U(0, 1) jitter), blended with the exponential tail for the open bucket.
 *
 * Not the midpoint of the edges: for the 1-second buckets the two coincide exactly (the table
 * holds only that second), but the wide buckets are left-skewed — 1500–1600 bucket 27 `[27, 32)`
 * has a table mean of 29.25 s against a midpoint of 29.5, and bucket 28 `[32, 40)` 35.47 against
 * 36.0. `distributionMedianSec` feeds the head's `median()`, which sets the `long` label and the
 * allocation, so it must describe the sampler rather than the edges. The midpoint is used only if
 * a table is somehow empty.
 */
export function bucketExpectedSec(band: ChessMimicBand, bucket: number): number {
	const lo = CLOCK_BUCKET_BOUNDARIES[bucket] ?? 0;
	const hi = CLOCK_BUCKET_BOUNDARIES[bucket + 1] ?? Number.POSITIVE_INFINITY;
	const midpoint = Number.isFinite(hi) ? (lo + hi) / 2 : lo;
	const t = tableFor(band, bucket);
	let total = 0;
	let acc = 0;
	for (let i = 0; i < t.seconds.length; i++) {
		total += t.weights[i] ?? 0;
		acc += ((t.seconds[i] ?? 0) + 0.5) * (t.weights[i] ?? 0);
	}
	if (!(total > 0)) return midpoint;
	const tableMean = acc / total;
	if (t.coverage >= 1) return tableMean;
	return t.coverage * tableMean + (1 - t.coverage) * (t.tailStartS + CM.openBucketTailMeanS);
}

/** Median of the bucket distribution (the expected seconds of the bucket at 50 % mass). */
export function distributionMedianSec(band: ChessMimicBand, probs: readonly number[]): number {
	let total = 0;
	for (const p of probs) total += p;
	if (!(total > 0)) return bucketExpectedSec(band, 0);
	let acc = 0;
	for (let b = 0; b < CM.nBuckets; b++) {
		acc += (probs[b] ?? 0) / total;
		if (acc >= 0.5) return bucketExpectedSec(band, b);
	}
	return bucketExpectedSec(band, CM.nBuckets - 1);
}
