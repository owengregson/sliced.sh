// test/core/timing/chessmimic-buckets.test.ts — Task 34: clock buckets (clock_buckets.json →
// buckets.json), the validity mask and bucket → seconds decoding with the empirical samples.
import { describe, expect, it } from "bun:test";
import { CHESSMIMIC_BANDS } from "@core/constants/models";
import { createRng } from "@core/rng";
import {
	bucketExpectedSec,
	bucketIndexOf,
	bucketMask,
	CHESSMIMIC_BUCKETS,
	CLOCK_BUCKET_BOUNDARIES,
	distributionMedianSec,
	sampleBucket,
	sampleWithinBucket,
} from "@core/timing/chessmimic-buckets";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import buckets from "../../../assets/models/chessmimic/buckets.json";

const CM = TIMING_CONSTANTS.chessmimic;

function probsAt(indices: number[], weights?: number[]): number[] {
	const p = new Array<number>(30).fill(0);
	indices.forEach((i, k) => {
		p[i] = weights?.[k] ?? 1 / indices.length;
	});
	return p;
}

describe("buckets.json", () => {
	it("every registered band has 30 buckets with the same edges: 1 s to 27, then 32, 40, ∞", () => {
		for (const band of CHESSMIMIC_BANDS) {
			const b = CHESSMIMIC_BUCKETS[band];
			expect(b).toEqual(buckets[band]);
			expect(b.n_buckets).toBe(CM.nBuckets);
			expect(b.boundaries).toHaveLength(CM.nBuckets + 1);
			expect(b.boundaries.slice(0, 28)).toEqual(Array.from({ length: 28 }, (_, i) => i));
			expect(b.boundaries.slice(28)).toEqual([32, 40, null]);
			expect(b.bucket_probabilities).toHaveLength(CM.nBuckets);
			expect(b.bucket_empirical_distributions).toHaveLength(CM.nBuckets);
			const prior = b.bucket_probabilities.reduce((a, x) => a + x, 0);
			expect(prior).toBeCloseTo(1, 2);
		}
		expect(CLOCK_BUCKET_BOUNDARIES).toHaveLength(CM.nBuckets + 1);
		expect(CLOCK_BUCKET_BOUNDARIES[0]).toBe(0);
		expect(CLOCK_BUCKET_BOUNDARIES[27]).toBe(27);
		expect(CLOCK_BUCKET_BOUNDARIES[28]).toBe(32);
		expect(CLOCK_BUCKET_BOUNDARIES[29]).toBe(40);
		expect(CLOCK_BUCKET_BOUNDARIES[30]).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("bucket index and validity mask", () => {
	it("bucketIndexOf follows searchsorted(right) − 1, clipped", () => {
		expect(bucketIndexOf(0)).toBe(0);
		expect(bucketIndexOf(0.99)).toBe(0);
		expect(bucketIndexOf(1)).toBe(1);
		expect(bucketIndexOf(26.5)).toBe(26);
		expect(bucketIndexOf(27)).toBe(27);
		expect(bucketIndexOf(31.9)).toBe(27);
		expect(bucketIndexOf(32)).toBe(28);
		expect(bucketIndexOf(40)).toBe(29);
		expect(bucketIndexOf(5000)).toBe(29);
		expect(bucketIndexOf(-3)).toBe(0);
	});
	it("bucketMask keeps buckets up to player_clock + increment, bucket 0 always", () => {
		expect(bucketMask(0, 0)).toEqual([true, ...new Array(29).fill(false)]);
		const m = bucketMask(4.5, 2);
		expect(m.slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
		expect(m.slice(7).some(Boolean)).toBe(false);
		expect(bucketMask(1000, 0).every(Boolean)).toBe(true);
		expect(bucketMask(-5, 0)[0]).toBe(true);
	});
});

describe("bucket sampling", () => {
	it("never samples a masked bucket and honours the temperature", () => {
		const rng = createRng("buckets");
		const probs = probsAt([0, 3, 12, 29], [0.1, 0.2, 0.3, 0.4]);
		const mask = bucketMask(10, 0);
		for (let i = 0; i < 2000; i++) {
			const b = sampleBucket(probs, mask, 1, rng);
			expect([0, 3]).toContain(b);
		}
		let hi = 0;
		for (let i = 0; i < 4000; i++)
			if (sampleBucket(probs, bucketMask(1000, 0), 0.2, rng) === 29) hi++;
		expect(hi / 4000).toBeGreaterThan(0.6);
		expect(sampleBucket(probsAt([12]), bucketMask(1, 0), 1, rng)).toBe(0);
	});
});

describe("within-bucket decoding (empirical integer second + U(0,1))", () => {
	it("stays inside the bucket edges for every band and bucket, without mass points", () => {
		const rng = createRng("within");
		for (const band of CHESSMIMIC_BANDS)
			for (let b = 0; b < CM.nBuckets; b++) {
				const seen = new Set<number>();
				for (let i = 0; i < 40; i++) {
					const t = sampleWithinBucket(band, b, rng);
					expect(t).toBeGreaterThanOrEqual(CLOCK_BUCKET_BOUNDARIES[b] ?? 0);
					expect(t).toBeLessThan(CLOCK_BUCKET_BOUNDARIES[b + 1] ?? Number.POSITIVE_INFINITY);
					seen.add(t);
				}
				expect(seen.size).toBe(40);
			}
	});
	it("the wide buckets follow the band's empirical second weights (N = 6 000)", () => {
		const rng = createRng("wide");
		const band = "1500_1600";
		const table = CHESSMIMIC_BUCKETS[band].bucket_empirical_distributions[27]?.distribution ?? {};
		const total = Object.values(table).reduce((a, x) => a + x, 0);
		const N = 6000;
		const counts = new Map<number, number>();
		for (let i = 0; i < N; i++) {
			const s = Math.floor(sampleWithinBucket(band, 27, rng));
			counts.set(s, (counts.get(s) ?? 0) + 1);
		}
		for (const [sec, weight] of Object.entries(table)) {
			const expected = weight / total;
			expect(Math.abs((counts.get(Number(sec)) ?? 0) / N - expected)).toBeLessThan(0.025);
		}
	});
	it("the open bucket draws 40–59 s from the table and a 60 s + Exp tail for the rest (N = 6 000)", () => {
		const rng = createRng("open");
		const band = "1500_1600";
		const dist = CHESSMIMIC_BUCKETS[band].bucket_empirical_distributions[29];
		const coverage = (dist?.coverage ?? 100) / 100;
		const N = 6000;
		let tail = 0;
		let sum = 0;
		let max = 0;
		for (let i = 0; i < N; i++) {
			const t = sampleWithinBucket(band, 29, rng);
			expect(t).toBeGreaterThanOrEqual(40);
			if (t >= 60) {
				tail++;
				sum += t - 60;
			}
			max = Math.max(max, t);
		}
		expect(Math.abs(tail / N - (1 - coverage))).toBeLessThan(0.025);
		expect(sum / tail).toBeGreaterThan(CM.openBucketTailMeanS * 0.85);
		expect(sum / tail).toBeLessThan(CM.openBucketTailMeanS * 1.15);
		expect(max).toBeGreaterThan(90);
	});
	it("bucketExpectedSec is the midpoint for finite buckets and the empirical mean for the open one", () => {
		expect(bucketExpectedSec("1500_1600", 0)).toBe(0.5);
		expect(bucketExpectedSec("1500_1600", 27)).toBeCloseTo(29.5, 6);
		const open = bucketExpectedSec("1500_1600", 29);
		expect(open).toBeGreaterThan(45);
		expect(open).toBeLessThan(70);
	});
	it("distributionMedianSec finds the 50 % bucket", () => {
		expect(distributionMedianSec("1500_1600", probsAt([4, 5, 6], [0.3, 0.4, 0.3]))).toBe(5.5);
		expect(distributionMedianSec("1500_1600", probsAt([2]))).toBe(2.5);
		expect(distributionMedianSec("1500_1600", new Array<number>(30).fill(0))).toBe(0.5);
	});
});
