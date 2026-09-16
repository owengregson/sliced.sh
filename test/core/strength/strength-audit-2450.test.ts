import { describe, expect, test } from "bun:test";
import { createRng } from "@core/rng";
import {
	distinctCandidateVerification,
	type GvCandidate,
	intuitionProb,
	recognitionDistribution,
} from "@core/strength/generate-verify";
import {
	distinctDistribution,
	independentDistribution,
	prior,
} from "../../../tools/human-match/strength-audit-2450";

const pool: GvCandidate[] = [
	{ uci: "a2a3", p: 0.72, shallowCp: 0, deepCp: 40 },
	{ uci: "b2b3", p: 0.23, shallowCp: 100, deepCp: -100 },
	{ uci: "c2c3", p: 0.05, shallowCp: -200, deepCp: 200 },
];
const E = 2450;
const equalMaps = (actual: ReadonlyMap<string, number>, expected: ReadonlyMap<string, number>) => {
	for (const [uci, p] of expected) expect(actual.get(uci)).toBeCloseTo(p, 10);
};

describe("cache-only strength audit", () => {
	test("Sep15 reconstruction matches preserved production distinct sampler for identical draws", () => {
		const samples = 4000;
		const I = intuitionProb(E);
		const expected = new Map([...prior(pool)].map(([uci, p]) => [uci, I * p]));
		const rng = { ...createRng("audit-baseline"), chance: () => false };
		for (let i = 0; i < samples; i++) {
			const result = distinctCandidateVerification({ survivors: pool, E, rng });
			if (result === null) throw new Error("Missing distinct result");
			expected.set(result.uci, (expected.get(result.uci) ?? 0) + (1 - I) / samples);
		}
		equalMaps(distinctDistribution(pool, E, "sep15", "audit-baseline", samples), expected);
	});

	test("two-proposal Markov law matches production exact law, including missing evidence", () => {
		for (const candidates of [
			pool,
			pool.map((c, i) => (i === 1 ? { uci: c.uci, p: c.p, deepCp: c.deepCp } : c)),
		])
			equalMaps(
				independentDistribution(candidates, E, [2]),
				recognitionDistribution({ survivors: candidates, E })
			);
	});

	test("additional independent proposals preserve equal-score or entirely missing-evidence priors", () => {
		for (const candidates of [
			pool.map((c) => ({ ...c, shallowCp: 20 })),
			pool.map((c) => ({ uci: c.uci, p: c.p, deepCp: c.deepCp })),
		])
			equalMaps(independentDistribution(candidates, E, [4, 5, 6]), prior(candidates));
	});

	test("sequential comparison conserves mass and never invents zero tail probability", () => {
		const q = independentDistribution(pool, E, [4, 5, 6]);
		expect([...q.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
		for (const [uci, p] of prior(pool))
			expect(q.get(uci)).toBeGreaterThanOrEqual(intuitionProb(E) * p);
	});
});
