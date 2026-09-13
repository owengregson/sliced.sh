// test/core/strength/generate-verify.test.ts — generate-and-verify below 2600 (2026-09-13, H3/H4):
// the rating tables, the distinct draw from Maia's distribution, verification at the human depth,
// the argmax with perception noise, the fallbacks, and the KL meter. Pure and seeded throughout.
import { describe, expect, it } from "bun:test";
import { GENERATE_VERIFY as GV } from "@core/constants/generate-verify";
import { createRng, type Rng } from "@core/rng";
import { sigmaFor } from "@core/strength/elo-map";
import {
	candidateBase,
	candidateCount,
	drawDistribution,
	type GvCandidate,
	generateAndVerify,
	gvKl,
	intuitionProb,
	verifySigmaFor,
} from "@core/strength/generate-verify";

/** Four opening moves with Maia's mass; the deep referee prefers the least likely. */
const FOUR: GvCandidate[] = [
	{ uci: "d2d4", p: 0.5, deepCp: 30, shallowCp: 25 },
	{ uci: "e2e4", p: 0.3, deepCp: 50, shallowCp: 40 },
	{ uci: "g1f3", p: 0.15, deepCp: 10, shallowCp: 10 },
	{ uci: "c2c4", p: 0.05, deepCp: 0, shallowCp: 5 },
];

/** An rng whose intuition coin is fixed (and, optionally, whose perception noise is zero). */
function fixed(seed: string, intuition: boolean, silent = false): Rng {
	const base = createRng(seed);
	return { ...base, chance: () => intuition, ...(silent ? { normal: () => 0 } : {}) };
}

function maiaOver(survivors: readonly GvCandidate[]): Map<string, number> {
	return new Map(survivors.map((c) => [c.uci, c.p]));
}

describe("rating tables", () => {
	it("candidateBase follows the knots (2 at 800, 3 at 1400, 4 at 2000, 5 at 2500) and is monotone", () => {
		expect(candidateBase(800)).toBe(2);
		expect(candidateBase(1400)).toBe(3);
		expect(candidateBase(2000)).toBe(4);
		expect(candidateBase(2500)).toBe(5);
		expect(candidateBase(500)).toBe(2);
		expect(candidateBase(3000)).toBe(5);
		let prev = 0;
		for (let E = 400; E <= 3200; E += 50) {
			const k = candidateBase(E);
			expect(k).toBeGreaterThanOrEqual(prev);
			prev = k;
		}
	});
	it("candidateCount is the base ± jitter, never below min, and its mean is monotone in E", () => {
		const rng = createRng("k");
		const means: number[] = [];
		for (const E of [800, 1100, 1400, 1700, 2000, 2300, 2500]) {
			let sum = 0;
			const n = 300;
			for (let i = 0; i < n; i++) {
				const k = candidateCount(E, rng);
				expect(k).toBeGreaterThanOrEqual(GV.candidates.min);
				expect(k).toBeLessThanOrEqual(GV.candidates.max);
				expect(Math.abs(k - candidateBase(E))).toBeLessThanOrEqual(GV.candidates.jitter);
				sum += k;
			}
			means.push(sum / n);
		}
		for (let i = 1; i < means.length; i++)
			expect(means[i] ?? 0).toBeGreaterThanOrEqual((means[i - 1] ?? 0) - 0.05);
		expect(means[0] ?? 0).toBeLessThan(means[means.length - 1] ?? 0);
	});
	it("verifySigmaFor is sigmaFor floored by the verifySigmaFloorCp knots, flat outside them", () => {
		// The floor binds everywhere in range: sigmaFor is 47.4 at 900 and 8 at 2500.
		expect(verifySigmaFor(900)).toBeCloseTo(57.5, 9);
		expect(verifySigmaFor(2000)).toBe(30);
		expect(verifySigmaFor(2500)).toBe(20);
		expect(verifySigmaFor(3000)).toBe(20);
		expect(verifySigmaFor(500)).toBe(60);
		for (let E = 400; E <= 3200; E += 50) {
			expect(verifySigmaFor(E)).toBeGreaterThanOrEqual(sigmaFor(E));
			expect(verifySigmaFor(E)).toBeGreaterThanOrEqual(GV.verifySigmaFloorCp.at(-1)?.[1] ?? 0);
		}
	});
	it("intuitionProb ramps 0.55 at 800 → 0.10 at 2500, flat outside, monotone non-increasing", () => {
		expect(intuitionProb(800)).toBeCloseTo(0.55, 12);
		expect(intuitionProb(2500)).toBeCloseTo(0.1, 12);
		expect(intuitionProb(500)).toBeCloseTo(0.55, 12);
		expect(intuitionProb(3000)).toBeCloseTo(0.1, 12);
		expect(intuitionProb(1650)).toBeCloseTo(0.325, 12);
		let prev = 1;
		for (let E = 400; E <= 3200; E += 50) {
			const p = intuitionProb(E);
			expect(p).toBeLessThanOrEqual(prev);
			prev = p;
		}
	});
});

describe("generate", () => {
	it("the k candidates are distinct and k matches the table", () => {
		const rng = fixed("distinct", false);
		for (let i = 0; i < 200; i++) {
			const r = generateAndVerify({ survivors: FOUR, E: 2000, rng });
			expect(r).not.toBeNull();
			if (r === null) return;
			expect(r.intuition).toBe(false);
			expect(r.k).toBe(r.considered.length);
			expect(r.k).toBeGreaterThanOrEqual(Math.min(GV.candidates.min, FOUR.length));
			expect(r.k).toBeLessThanOrEqual(FOUR.length);
			expect(new Set(r.considered.map((c) => c.uci)).size).toBe(r.k);
		}
	});
	it("with k = 1 (intuition) the pick's distribution is Maia's over the survivors", () => {
		const rng = fixed("intuition", true);
		const N = 4000;
		const counts = new Map<string, number>();
		for (let i = 0; i < N; i++) {
			const r = generateAndVerify({ survivors: FOUR, E: 1200, rng });
			expect(r?.intuition).toBe(true);
			expect(r?.k).toBe(1);
			counts.set(r?.uci ?? "", (counts.get(r?.uci ?? "") ?? 0) + 1);
		}
		// Pearson χ² against Maia's masses, 3 degrees of freedom: 16.27 is the 0.1 % critical value.
		let chi2 = 0;
		for (const c of FOUR) {
			const expected = c.p * N;
			chi2 += ((counts.get(c.uci) ?? 0) - expected) ** 2 / expected;
		}
		expect(chi2).toBeLessThan(16.27);
	});
	it("the intuition coin follows pIntuition(E)", () => {
		const rng = createRng("coin");
		const N = 2000;
		for (const E of [900, 2300]) {
			let intuitive = 0;
			for (let i = 0; i < N; i++) {
				const r = generateAndVerify({ survivors: FOUR, E, rng });
				if (r?.intuition) intuitive++;
			}
			expect(Math.abs(intuitive / N - intuitionProb(E))).toBeLessThan(0.035);
		}
	});
});

describe("verify and compare", () => {
	it("the pick follows the SHALLOW score when it reverses the deep order", () => {
		// The deep referee sees a2a3 refuted; at the human depth it still looks best — a truncation
		// error for the right reason.
		const survivors: GvCandidate[] = [
			{ uci: "e2e4", p: 0.5, deepCp: 100, shallowCp: -50 },
			{ uci: "a2a3", p: 0.5, deepCp: -120, shallowCp: 80 },
		];
		for (let i = 0; i < 20; i++) {
			const r = generateAndVerify({
				survivors,
				E: 2000,
				shallowDepth: 6,
				rng: fixed(`shallow-${i}`, false, true),
			});
			expect(r?.uci).toBe("a2a3");
			expect(r?.k).toBe(2);
			expect(r?.verifyDepth).toBe(6);
			expect(r?.considered.every((c) => c.verified)).toBe(true);
		}
	});
	it("a candidate missing from the shallow frame falls back to its deep score and is marked unverified", () => {
		const survivors: GvCandidate[] = [
			{ uci: "e2e4", p: 0.5, deepCp: 40, shallowCp: 10 },
			{ uci: "d2d4", p: 0.5, deepCp: 30 },
		];
		const r = generateAndVerify({
			survivors,
			E: 2000,
			shallowDepth: 6,
			rng: fixed("missing", false, true),
		});
		expect(r?.uci).toBe("d2d4");
		const rows = new Map(r?.considered.map((c) => [c.uci, c]));
		expect(rows.get("d2d4")).toMatchObject({ verified: false, cp: 30, score: 30 });
		expect(rows.get("e2e4")).toMatchObject({ verified: true, cp: 10, score: 10 });
		expect(r?.rationale.join("\n")).toContain("1 unverified");
		expect(r?.rationale.join("\n")).toContain("d2d4 p=0.5 deep 30 → 30 ✓");
	});
	it("without any shallow frame verifyDepth is 0 and the rationale says the deep scores stood in", () => {
		const bare = FOUR.map(({ uci, p, deepCp }) => ({ uci, p, deepCp }));
		const r = generateAndVerify({ survivors: bare, E: 2000, rng: fixed("bare", false, true) });
		expect(r?.verifyDepth).toBe(0);
		expect(r?.considered.every((c) => !c.verified)).toBe(true);
		expect(r?.rationale[0]).toContain("no shallow frame, deep scores stood in");
	});
	it("the argmax bias scales with E: 5 equal-p candidates, the best 300 cp ahead at the human depth", () => {
		const survivors: GvCandidate[] = ["a", "b", "c", "d", "e"].map((uci, i) => ({
			uci,
			p: 0.2,
			deepCp: 0,
			shallowCp: i === 0 ? 300 : 0,
		}));
		const N = 4000;
		const strong = drawDistribution({ survivors, E: 2300, shallowDepth: 10 }, N, createRng("2300"));
		const weak = drawDistribution({ survivors, E: 900, shallowDepth: 2 }, N, createRng("900"));
		expect(strong.get("a") ?? 0).toBeGreaterThan(0.8);
		expect(weak.get("a") ?? 0).toBeLessThan(0.6);
		expect(weak.get("a") ?? 0).toBeGreaterThan(0.2);
		// σ is larger and k smaller at 900: the wrapper moves less far from Maia there.
		expect(sigmaFor(900)).toBeGreaterThan(sigmaFor(2300));
		expect(gvKl(weak, maiaOver(survivors))).toBeLessThan(gvKl(strong, maiaOver(survivors)));
	});
	it("the rationale names k, the pool, the depth, σ and every candidate's scores", () => {
		const r = generateAndVerify({
			survivors: FOUR,
			E: 2000,
			shallowDepth: 8,
			rng: fixed("rows", false),
		});
		const text = r?.rationale.join("\n") ?? "";
		// σ is the verification noise: sigmaFor(2000) = 18.5 floored to the 30 cp knot.
		expect(verifySigmaFor(2000)).toBe(30);
		expect(text).toMatch(
			/^generate-verify: k=[2-4] of 4 survivors \(pIntuition 0\.23\), verified at depth 8, σ=30/m
		);
		expect(text).toMatch(/^ {2}[a-h][1-8][a-h][1-8] p=0\.\d+ shallow -?\d+ → -?\d+/m);
		expect(text).toContain("✓");
		expect(r?.considered.filter((c) => c.uci === r?.uci)).toHaveLength(1);
	});
	it("the intuition rationale is a single row", () => {
		const r = generateAndVerify({ survivors: FOUR, E: 1000, rng: fixed("one-row", true) });
		expect(r?.rationale).toHaveLength(1);
		expect(r?.rationale[0]).toMatch(
			/^generate-verify: intuition — played on recognition alone \(p=0\.5 at E, 4 survivors\)$/
		);
	});
});

describe("fallbacks", () => {
	it("returns null when disabled — by the input flag or by the registry default", () => {
		expect(
			generateAndVerify({ survivors: FOUR, E: 1500, rng: createRng(1), enabled: false })
		).toBeNull();
		expect(GV.enabled).toBe(true);
		expect(generateAndVerify({ survivors: FOUR, E: 1500, rng: createRng(1) })).not.toBeNull();
	});
	it("returns null with fewer than two survivors carrying mass", () => {
		const one = [FOUR[0] ?? { uci: "d2d4", p: 1, deepCp: 0 }];
		expect(generateAndVerify({ survivors: one, E: 1500, rng: createRng(2) })).toBeNull();
		expect(generateAndVerify({ survivors: [], E: 1500, rng: createRng(2) })).toBeNull();
		const massless: GvCandidate[] = [
			{ uci: "d2d4", p: 0.6, deepCp: 0 },
			{ uci: "e2e4", p: 0, deepCp: 0 },
		];
		expect(generateAndVerify({ survivors: massless, E: 1500, rng: createRng(2) })).toBeNull();
	});
	it("never draws a survivor without Maia mass", () => {
		const survivors: GvCandidate[] = [
			{ uci: "d2d4", p: 0.5, deepCp: 0, shallowCp: 0 },
			{ uci: "e2e4", p: 0.5, deepCp: 0, shallowCp: 0 },
			{ uci: "f2f3", p: 0, deepCp: 500, shallowCp: 500 },
		];
		const q = drawDistribution({ survivors, E: 2400 }, 500, createRng("massless"));
		expect(q.get("f2f3")).toBeUndefined();
	});
});

/**
 * The QA doc's "typical" pool — 6 survivors, one move refuted only at depth (c: shallow 30, deep
 * −40) and one underrated at the human depth (d: shallow −10, deep 20) — with the rating-correct
 * human depth. The fidelity budget below is asserted on it.
 */
const TYPICAL: GvCandidate[] = [
	{ uci: "a", p: 0.42, deepCp: 30, shallowCp: 35 },
	{ uci: "b", p: 0.25, deepCp: 55, shallowCp: 45 },
	{ uci: "c", p: 0.14, deepCp: -40, shallowCp: 30 },
	{ uci: "d", p: 0.09, deepCp: 20, shallowCp: -10 },
	{ uci: "e", p: 0.06, deepCp: 5, shallowCp: 0 },
	{ uci: "f", p: 0.04, deepCp: -60, shallowCp: -50 },
];
/** `HUMAN_DEPTH` realised at the measured ratings. */
const HUMAN_DEPTH_AT: Record<number, number> = {
	900: 3,
	1100: 4,
	1300: 5,
	1500: 6,
	1700: 7,
	1900: 8,
	2100: 9,
	2300: 10,
	2500: 10,
};
/**
 * `klFromMaia` ceilings (nats) by band — the QA doc's budget: measured × ~1.5, rounded, so a
 * silent re-tune of a knot trips it. With the verification noise floor the typical pool measures
 * 0.007 / 0.014 / 0.018 / 0.030 / 0.050 / 0.072 / 0.096 / 0.151 / 0.215 at 20 000 samples.
 */
const KL_BUDGET: ReadonlyArray<readonly [E: number, ceiling: number]> = [
	[900, 0.03],
	[1100, 0.03],
	[1300, 0.06],
	[1500, 0.06],
	[1700, 0.17],
	[1900, 0.17],
	[2100, 0.25],
	[2300, 0.45],
	[2500, 0.65],
];

describe("the fidelity budget on the typical pool (§8.3)", () => {
	const N = 4000;
	const bestDeep = Math.max(...TYPICAL.map((c) => c.deepCp));
	let maiaAlone = 0;
	for (const c of TYPICAL) maiaAlone += c.p * (bestDeep - c.deepCp);
	const cells = KL_BUDGET.map(([E, ceiling]) => {
		const q = drawDistribution(
			{ survivors: TYPICAL, E, shallowDepth: HUMAN_DEPTH_AT[E] ?? 10 },
			N,
			createRng(`budget:${E}`)
		);
		let loss = 0;
		for (const c of TYPICAL) loss += (q.get(c.uci) ?? 0) * (bestDeep - c.deepCp);
		return { E, ceiling, kl: gvKl(q, maiaOver(TYPICAL)), loss };
	});
	it("klFromMaia stays under the stated ceiling in every band", () => {
		for (const cell of cells)
			expect(cell.kl, `E=${cell.E}: KL ${cell.kl.toFixed(3)}`).toBeLessThanOrEqual(cell.ceiling);
	});
	it("mean raw deep loss is non-increasing in E (1 cp tolerance) and below Maia alone from 1500", () => {
		expect(maiaAlone).toBeCloseTo(34.55, 2);
		for (let i = 1; i < cells.length; i++) {
			const prev = cells[i - 1];
			const cur = cells[i];
			if (prev === undefined || cur === undefined) continue;
			expect(cur.loss, `rose ${prev.E} → ${cur.E}`).toBeLessThanOrEqual(prev.loss + 1);
		}
		for (const cell of cells) if (cell.E >= 1500) expect(cell.loss).toBeLessThan(maiaAlone);
	});
	it("the top band is not an argmax: mean deep loss at 2300 and 2500 drops ≤ 30 % against Maia alone", () => {
		// Measured 15 % at 2300 and 23 % at 2500 (was 44 % and 61 % before the σ floor); the ceiling
		// leaves ~2σ of Monte Carlo room at 4000 draws.
		for (const cell of cells)
			if (cell.E >= 2300)
				expect(
					1 - cell.loss / maiaAlone,
					`E=${cell.E}: loss ${cell.loss.toFixed(1)}`
				).toBeLessThanOrEqual(0.3);
	});
});

describe("drawDistribution and gvKl", () => {
	it("drawDistribution sums to 1 and covers only the survivors", () => {
		const q = drawDistribution({ survivors: FOUR, E: 1500, shallowDepth: 4 }, 1000, createRng("q"));
		let total = 0;
		for (const [uci, mass] of q) {
			expect(FOUR.some((c) => c.uci === uci)).toBe(true);
			total += mass;
		}
		expect(total).toBeCloseTo(1, 9);
	});
	it("drawDistribution falls back to Maia's renormalised mass when the path is off", () => {
		const q = drawDistribution({ survivors: FOUR, E: 1500, enabled: false }, 100, createRng("off"));
		for (const c of FOUR) expect(q.get(c.uci)).toBeCloseTo(c.p, 12);
		expect(gvKl(q, maiaOver(FOUR))).toBeCloseTo(0, 12);
	});
	it("gvKl is 0 for identical distributions, positive otherwise, and infinite off Maia's support", () => {
		const p = maiaOver(FOUR);
		expect(gvKl(p, p)).toBe(0);
		const q = new Map([
			["d2d4", 0.25],
			["e2e4", 0.6],
			["g1f3", 0.1],
			["c2c4", 0.05],
		]);
		expect(gvKl(q, p)).toBeGreaterThan(0);
		expect(gvKl(new Map([["b1c3", 1]]), p)).toBe(Number.POSITIVE_INFINITY);
		// renormalised over q's support: Maia mass outside it does not count
		const wide = new Map([...p, ["b1c3", 0.5]]);
		expect(gvKl(p, wide)).toBeCloseTo(0, 12);
	});
	it("the intuition-only draw stays within a hair of Maia (KL ≈ 0)", () => {
		const q = drawDistribution({ survivors: FOUR, E: 1000 }, 4000, fixed("kl-1", true));
		expect(gvKl(q, maiaOver(FOUR))).toBeLessThan(0.01);
	});
});
