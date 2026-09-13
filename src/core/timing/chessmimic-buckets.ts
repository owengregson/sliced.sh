/** Per-checkpoint timing bins, empirical within-bin sampling, and masked distribution statistics. */

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

const boundaryCache = new Map<ChessMimicBand, readonly number[]>();

/** Every checkpoint owns its bucket schema; the novice checkpoint uses two-second early bins. */
export function clockBucketBoundaries(band: ChessMimicBand): readonly number[] {
	const cached = boundaryCache.get(band);
	if (cached) return cached;
	const definition = CHESSMIMIC_BUCKETS[band];
	if (!definition) throw new RangeError(`chessmimic buckets: missing ${band}`);
	const edges = edgesOf(definition);
	if (
		edges.length !== CM.nBuckets + 1 ||
		edges[0] !== 0 ||
		edges.some((edge, i) => i > 0 && !(edge > (edges[i - 1] ?? 0)))
	)
		throw new RangeError(`chessmimic buckets: invalid edges for ${band}`);
	const frozen = Object.freeze(edges);
	boundaryCache.set(band, frozen);
	return frozen;
}

/** Default narrow-band edges retained for callers without a selected checkpoint. */
export const CLOCK_BUCKET_BOUNDARIES: readonly number[] = clockBucketBoundaries("1500_1600");

/** `searchsorted(boundaries[:-1], t, "right") − 1`, clipped to `[0, n − 1]`. */
export function bucketIndexOf(seconds: number, band: ChessMimicBand = "1500_1600"): number {
	const edges = clockBucketBoundaries(band);
	for (let b = CM.nBuckets - 1; b >= 0; b--) if (seconds >= (edges[b] ?? 0)) return b;
	return 0;
}

/** Buckets whose lower edge is within `player_clock + increment`; bucket 0 always valid. */
export function bucketMask(
	playerClockS: number,
	incrementS: number,
	band: ChessMimicBand = "1500_1600"
): boolean[] {
	const maxValid = bucketIndexOf(Math.max(0, playerClockS + incrementS), band);
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
	const open = !Number.isFinite(clockBucketBoundaries(band)[bucket + 1] ?? Number.NaN);
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
	const lo = clockBucketBoundaries(band)[bucket] ?? 0;
	const hi = clockBucketBoundaries(band)[bucket + 1] ?? Number.POSITIVE_INFINITY;
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

export function distributionMeanSec(
	band: ChessMimicBand,
	probs: readonly number[],
	mask: readonly boolean[],
	temperature = 1
): number {
	const { items, weights, total } = maskedWeights(probs, mask, temperature);
	if (!(total > 0)) return bucketExpectedSec(band, 0);
	return (
		items.reduce((sum, bucket, i) => sum + bucketExpectedSec(band, bucket) * (weights[i] ?? 0), 0) /
		total
	);
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
