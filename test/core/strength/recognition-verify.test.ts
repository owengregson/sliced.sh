import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import {
	distinctCandidateVerification,
	drawDistribution,
	type GvCandidate,
	generateAndVerify,
	intuitionProb,
	recognitionDistribution,
} from "@core/strength/generate-verify";

const POOL: GvCandidate[] = [
	{ uci: "e2e4", p: 0.89, deepCp: 1000, shallowCp: 10 },
	{ uci: "d2d4", p: 0.1, deepCp: -1000, shallowCp: 10 },
	{ uci: "g1f3", p: 0.01, deepCp: 0, shallowCp: 10 },
];

describe("recognition-preserving verification", () => {
	it("equal shallow evidence exactly preserves highly unequal Maia probabilities", () => {
		for (const E of [400, 900, 1400, 1900, 2400, 2800]) {
			const q = recognitionDistribution({ survivors: POOL, E });
			for (const c of POOL) expect(q.get(c.uci)).toBeCloseTo(c.p, 14);
		}
	});
	it("missing shallow evidence cannot borrow deep scores or erase unverified probability", () => {
		const survivors = POOL.map(({ shallowCp: _, ...c }) => c);
		const q = recognitionDistribution({ survivors, E: 2300 });
		for (const c of POOL) expect(q.get(c.uci)).toBeCloseTo(c.p, 14);
		const partial = [POOL[0]!, { ...POOL[1]!, shallowCp: 300 }, survivors[2]!];
		const qPartial = recognitionDistribution({ survivors: partial, E: 2300 });
		expect(qPartial.get("g1f3")).toBeCloseTo(0.01, 14);
		expect(qPartial.get("d2d4")).toBeGreaterThan(0.1);
		const changedDeep = partial.map((c, i) => ({ ...c, deepCp: i * 100000 }));
		expect(recognitionDistribution({ survivors: changedDeep, E: 2300 })).toEqual(qPartial);
	});
	it("each likelihood ratio is bounded and no positive tail is rounded to zero", () => {
		const survivors = POOL.map((c, i) => ({ ...c, shallowCp: i * 100000 }));
		for (const E of [400, 900, 1900, 2800]) {
			const q = recognitionDistribution({ survivors, E });
			const intuition = intuitionProb(E);
			expect([...q.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14);
			for (const c of survivors) {
				expect(q.get(c.uci)! / c.p).toBeGreaterThanOrEqual(intuition);
				expect(q.get(c.uci)! / c.p).toBeLessThanOrEqual(2 - intuition);
			}
		}
	});
	it("the live stochastic sampler agrees with the exact probability law", () => {
		for (const missing of [false, true]) {
			const survivors = POOL.map((c, i) => ({
				...c,
				shallowCp: missing && i === 1 ? Number.NaN : i * 100,
			}));
			const input = { survivors, E: 2300, shallowDepth: 8 };
			const q = recognitionDistribution(input);
			const counts = new Map<string, number>();
			const rng = createRng(`recognition-law:${missing}`);
			const n = 30000;
			for (let i = 0; i < n; i++) {
				const result = generateAndVerify({ ...input, rng });
				expect(result).not.toBeNull();
				counts.set(result!.uci, (counts.get(result!.uci) ?? 0) + 1);
			}
			let chi2 = 0;
			for (const [uci, p] of q) chi2 += ((counts.get(uci) ?? 0) - n * p) ** 2 / (n * p);
			expect(chi2).toBeLessThan(13.82); // 0.1% critical value, two degrees of freedom.
		}
	});
	it("the meter is exact, deterministic, and consumes no random draws in the ordinary range", () => {
		const input = { survivors: POOL, E: 2300 };
		const rng = createRng("meter");
		const untouched = createRng("meter");
		expect(drawDistribution(input, 1, rng)).toEqual(recognitionDistribution(input));
		expect(rng.next()).toBe(untouched.next());
	});
	it("zero, malformed and duplicate mass cannot receive extra recognition tickets", () => {
		const survivors = [
			...POOL,
			POOL[0]!,
			{ uci: "a", p: Number.NaN, deepCp: 0 },
			{ uci: "b", p: Number.POSITIVE_INFINITY, deepCp: 0 },
			{ uci: "c", p: 0, deepCp: 0 },
		];
		expect(recognitionDistribution({ survivors, E: 1200 })).toEqual(
			recognitionDistribution({ survivors: POOL, E: 1200 })
		);
		expect(recognitionDistribution({ survivors: [], E: 1200 }).size).toBe(0);
	});
	it("upper verification is byte-for-byte the existing stochastic path for identical seeds", () => {
		for (const E of [2801, 2900, 3000])
			for (let seed = 0; seed < 100; seed++) {
				const input = { survivors: POOL, E, shallowDepth: 12 };
				expect(generateAndVerify({ ...input, rng: createRng(seed) })).toEqual(
					distinctCandidateVerification({ ...input, rng: createRng(seed) })
				);
			}
	});
});
