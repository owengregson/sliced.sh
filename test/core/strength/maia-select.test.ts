// test/core/strength/maia-select.test.ts — Maia-3 move selection below 2600 (2026-09-11):
// the draw over the engine's scored lines, the rails on the engine's raw scores, the fallbacks,
// and the accounting `finish()` keeps for every source. 2026-09-13: the draw is at T = 1 always
// and judged at `maiaSelfElo` (H2/H5); the rating-ramped rails, the meters, the tie-break and the
// ≥ 2600 prior are pinned in `selector-rails.test.ts`.
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { policyEntropy } from "@core/policy/maia-policy";
import type { PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import { winProb } from "@core/strength/elo-map";
import { lossCapFor } from "@core/strength/maia-select";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { maiaSelfElo } from "@core/strength/selection-elo";
import type { SelectionState } from "@core/strength/types";
import type { EvalLine } from "@typedefs/engine";
import { pinIdentityCalibration } from "../../fakes/maia-calibration";
import { type CtxOverrides, ctx, flatPrior, line, START } from "./helpers";

pinIdentityCalibration();

/** Four near-equal opening moves; Maia's ordering deliberately disagrees with the engine's. */
const FOUR: EvalLine[] = [
	line(START, "e2e4", { cp: 50 }, 1),
	line(START, "d2d4", { cp: 30 }, 2),
	line(START, "g1f3", { cp: 10 }, 3),
	line(START, "c2c4", { cp: 0 }, 4),
];
const P: Record<string, number> = { d2d4: 0.5, e2e4: 0.3, g1f3: 0.15, c2c4: 0.05 };

function policy(
	moves: Array<[string, number]>,
	overrides: Partial<PolicyResult> = {}
): PolicyResult {
	return { moves, wdl: [0.3, 0.4, 0.3], size: "79m", ms: 42, ...overrides };
}
const MAIA_FOUR = policy(Object.entries(P));

function draws(
	lines: readonly EvalLine[],
	maia: PolicyResult,
	n: number,
	overrides: CtxOverrides = {},
	seed = "maia"
): Map<string, number> {
	const rng = createRng(seed);
	const counts = new Map<string, number>();
	for (let i = 0; i < n; i++) {
		const c = ctx({ ...overrides, maia, rng, state: createSelectionState() });
		const m = selectMove(lines, c, flatPrior(lines));
		counts.set(m.uci, (counts.get(m.uci) ?? 0) + 1);
	}
	return counts;
}

/** `p^(1/T)` renormalised over `moves`. */
function tempered(moves: Record<string, number>, T: number): Record<string, number> {
	let sum = 0;
	const out: Record<string, number> = {};
	for (const [uci, p] of Object.entries(moves)) {
		out[uci] = p ** (1 / T);
		sum += out[uci] ?? 0;
	}
	for (const uci of Object.keys(out)) out[uci] = (out[uci] ?? 0) / sum;
	return out;
}

/** The rating the Maia branch judges `overrides` at (form 0, no clock pressure unless given). */
function maiaE(maia: PolicyResult, overrides: CtxOverrides = {}): number {
	const c = ctx(overrides);
	return maiaSelfElo({
		targetElo: c.targetElo,
		form: c.form,
		blunderScale: c.blunderScale,
		pressureReduction: 0,
		contextEloPenalty: c.contextEloPenalty,
		ambiguityEloPenalty: MAIA.context.ambiguityElo * policyEntropy(maia.moves),
	});
}

describe("Maia knobs", () => {
	it("lossCapFor interpolates the knots and is flat outside them", () => {
		expect(lossCapFor(500)).toBe(0.55);
		expect(lossCapFor(800)).toBe(0.55);
		expect(lossCapFor(1100)).toBeCloseTo(0.5, 12);
		expect(lossCapFor(1700)).toBeCloseTo(0.4, 12);
		expect(lossCapFor(2600)).toBe(0.25);
		expect(lossCapFor(3000)).toBe(0.25);
	});
	it("the temperature is 1 and nothing scales it any more (H2)", () => {
		// The owner's ruling: the models run as advertised — the default is the raw distribution.
		expect(MAIA.temperature).toBe(1);
		expect("blunderScaleFloor" in MAIA).toBe(false);
	});
});

describe("selectMove — Maia draw (a)(b)", () => {
	const N = 2000;
	it("(a) the draw frequencies are Maia's probabilities", () => {
		const counts = draws(FOUR, MAIA_FOUR, N);
		for (const [uci, p] of Object.entries(P))
			expect(Math.abs((counts.get(uci) ?? 0) / N - p)).toBeLessThan(0.035);
	});
	it("(a) at the default T the frequencies follow p^(1/T) renormalised — Maia's own at T = 1", () => {
		const counts = draws(FOUR, MAIA_FOUR, N, {}, "default-T");
		const expected = tempered(P, MAIA.temperature);
		for (const [uci, p] of Object.entries(expected))
			expect(Math.abs((counts.get(uci) ?? 0) / N - p)).toBeLessThan(0.035);
		// as advertised: the favourite is drawn at its raw probability, not amplified
		expect(Math.abs((counts.get("d2d4") ?? 0) / N - (P.d2d4 ?? 0))).toBeLessThan(0.035);
	});
	it("(b) the mistakes slider no longer heats or cools the draw: it moves the rating (H2)", () => {
		// With no rail binding, the same seed draws the same sequence at every slider position —
		// the slider reaches the draw only through `maiaE`, and here nothing depends on it.
		const cold = draws(FOUR, MAIA_FOUR, N, { blunderScale: 0 }, "slider");
		const warm = draws(FOUR, MAIA_FOUR, N, { blunderScale: 1 }, "slider");
		const hot = draws(FOUR, MAIA_FOUR, N, { blunderScale: 2 }, "slider");
		expect([...cold]).toEqual([...warm]);
		expect([...warm]).toEqual([...hot]);
		for (const [scale, offset] of [
			[0, 250],
			[1, 0],
			[2, -250],
		] as const) {
			const m = selectMove(
				FOUR,
				ctx({ maia: MAIA_FOUR, blunderScale: scale, rng: createRng("slider-row") }),
				flatPrior(FOUR)
			);
			const E = maiaE(MAIA_FOUR, { blunderScale: scale });
			expect(E).toBeCloseTo(maiaE(MAIA_FOUR) + offset, 9);
			expect(m.rationale.join(" ")).toContain(`maia E=${Number(E.toFixed(1))}`);
			expect(m.maiaMeters?.selfElo).toBeCloseTo(E, 9);
		}
	});
	it("the rationale names the model, the rating, the pick's mass and rank among survivors, both masses, and the WDL", () => {
		const m = selectMove(FOUR, ctx({ maia: MAIA_FOUR, rng: createRng("rows") }), flatPrior(FOUR));
		const text = m.rationale.join("\n");
		expect(text).toMatch(
			/maia: 79m E=\d+ p=0\.\d+ rank [1-4]\/4 survivors scored mass 1 unscored 0 42 ms/
		);
		expect(text).toMatch(
			/maia E=\d+(\.\d)? \(pressure −0, slider \+0, context −0, ambiguity −\d+ \[entropy 0\.\d+\]\)/
		);
		expect(text).toContain("maia wdl: 0.3/0.4/0.3");
		expect(text).toMatch(/maia: no injected blunder channel \(b=0\.\d+ would have applied\)/);
		expect(text).not.toMatch(/^b=/m);
		expect(text).not.toContain("sampled:");
		expect(text).not.toContain("T=");
	});
	it("the row counts the combined scored mass and the lines the extra searchmoves search added", () => {
		// The pipeline scored Maia's two favourites outside the engine's four with a `searchmoves`
		// search (2026-09-12); the selector draws over all six and says what the extra pair covered.
		const extra = [line(START, "b1c3", { cp: 25 }, 5), line(START, "a2a3", { cp: -10 }, 6)];
		const maia = policy([
			["b1c3", 0.45],
			["e2e4", 0.25],
			["d2d4", 0.15],
			["a2a3", 0.09],
			["g1f3", 0.03],
			["h2h3", 0.03],
		]);
		const all = [...FOUR, ...extra];
		const m = selectMove(
			all,
			ctx({ maia, maiaExtra: ["b1c3", "a2a3"], rng: createRng("extra-row") }),
			flatPrior(all)
		);
		expect(m.source).toBe("maia");
		expect(m.rationale.join("\n")).toMatch(
			/maia: 79m E=\d+ p=0\.\d+ rank [1-6]\/6 survivors scored mass 0\.97 \(\+2 from searchmoves\) unscored 0\.03 42 ms/
		);
		expect(m.rationale.join(" ")).not.toContain("of the model's mass (<");
		expect(m.maiaMeters?.unscoredMass).toBeCloseTo(0.03, 9);
		// without the accounting hint the same pool draws the same move and the row has no suffix
		const plain = selectMove(all, ctx({ maia, rng: createRng("extra-row") }), flatPrior(all));
		expect(plain.uci).toBe(m.uci);
		expect(plain.rationale.join(" ")).toContain("scored mass 0.97 unscored 0.03 42 ms");
		expect(plain.rationale.join(" ")).not.toContain("searchmoves");
		// the extra lines are drawn over exactly like the main set's: b1c3 lands at its mass
		const counts = draws(all, maia, 2000, { maiaExtra: ["b1c3", "a2a3"] }, "extra-draws");
		expect(Math.abs((counts.get("b1c3") ?? 0) / 2000 - 0.45 / 0.97)).toBeLessThan(0.035);
		expect((counts.get("a2a3") ?? 0) / 2000).toBeGreaterThan(0.05);
	});
});

describe("selectMove — Maia rails (c)(d)(e)", () => {
	const N = 2000;
	it("(c) a mated line is never drawn even with most of Maia's mass", () => {
		const lines = [...FOUR, line(START, "f2f3", { mate: -1 }, 5)];
		const maia = policy([
			["f2f3", 0.9],
			["e2e4", 0.05],
			["d2d4", 0.05],
		]);
		const counts = draws(lines, maia, N, { blunderScale: 2 }, "mated");
		expect(counts.get("f2f3")).toBeUndefined();
		expect((counts.get("e2e4") ?? 0) + (counts.get("d2d4") ?? 0)).toBe(N);
	});
	it("(c) a hanging piece (PV shows the capture, loss ≥ 0.25) is never drawn once the rail is fully on", () => {
		// H1: the rail is certain from `MAIA.hangRail.fullElo`; its ramp below is pinned in
		// `selector-rails.test.ts`. −250 cp against +50 is loss 0.26: over the hang threshold, under
		// the loss cap at this rating, so only the hang rail can exclude it.
		const hanging = { ...line(START, "f2f3", { cp: -250 }, 5), pvSan: ["f3", "Bxe4"] };
		const maia = policy([
			["f2f3", 0.9],
			["e2e4", 0.1],
		]);
		const loss = winProb(50) - winProb(-250);
		const E = maiaE(maia, { targetElo: 2450 });
		expect(E).toBeGreaterThanOrEqual(MAIA.hangRail.fullElo);
		expect(loss).toBeGreaterThan(0.25);
		expect(loss).toBeLessThan(lossCapFor(E));
		const counts = draws([...FOUR, hanging], maia, N, { targetElo: 2450 }, "hangs");
		expect(counts.get("f2f3")).toBeUndefined();
		expect(counts.get("e2e4")).toBe(N);
	});
	it("(c) a raw win-fraction loss above lossCap(E) is never drawn, and the cap follows E", () => {
		// −800 cp: loss ≈ 0.50 against +50 — over the cap at a club rating, under the 800 cap (0.55).
		const bad = line(START, "f2f3", { cp: -800 }, 5);
		const loss = winProb(50) - winProb(-800);
		const maia = policy([
			["f2f3", 0.9],
			["e2e4", 0.1],
		]);
		const club = { targetElo: 1500, blunderScale: 2 };
		expect(loss).toBeGreaterThan(lossCapFor(maiaE(maia, club)));
		expect(loss).toBeLessThan(lossCapFor(maiaE(maia, { targetElo: 800, blunderScale: 2 })));
		const clubCounts = draws([...FOUR, bad], maia, N, club, "cap");
		expect(clubCounts.get("f2f3")).toBeUndefined();
		expect(clubCounts.get("e2e4")).toBe(N);
		const beginner = draws([...FOUR, bad], maia, 200, { targetElo: 800, blunderScale: 2 }, "cap");
		expect(beginner.get("f2f3") ?? 0).toBeGreaterThan(0);
		const m = selectMove(
			[...FOUR, bad],
			ctx({ targetElo: 1500, maia, rng: createRng("cap-row") }),
			flatPrior(FOUR)
		);
		const cap = Number(lossCapFor(maiaE(maia, { targetElo: 1500 })).toFixed(2));
		expect(m.rationale.join(" ")).toContain(
			`maia never-play: 1 line(s) excluded (loss cap ${cap} at E, mass 0.9)`
		);
		expect(m.maiaMeters?.railedMass).toBeCloseTo(0.9, 9);
	});
	it("(d) below minScoredMass the rationale says so and the draw still lands on a scored line", () => {
		// Maia's favourite is outside the engine's set; the scored four hold 0.2 of the mass.
		const maia = policy([
			["b1c3", 0.8],
			["e2e4", 0.1],
			["d2d4", 0.06],
			["g1f3", 0.03],
			["c2c4", 0.01],
		]);
		const m = selectMove(FOUR, ctx({ maia, rng: createRng("mass") }), flatPrior(FOUR));
		expect(m.source).toBe("maia");
		expect(m.rationale.join(" ")).toContain("covers 0.2 of the model's mass (< 0.35)");
		expect(m.rationale.join(" ")).toContain("scored mass 0.2");
		const counts = draws(FOUR, maia, N, {}, "mass-draws");
		expect(counts.get("b1c3")).toBeUndefined();
		let total = 0;
		for (const uci of ["e2e4", "d2d4", "g1f3", "c2c4"]) total += counts.get(uci) ?? 0;
		expect(total).toBe(N);
	});
	it("(e) the selector never returns a move no line scores, however likely — the pipeline's extra searchmoves search is what scores it first", () => {
		const maia = policy([
			["b1c3", 0.99],
			["e2e4", 0.01],
		]);
		const counts = draws(FOUR, maia, 500, { blunderScale: 2 }, "unscored");
		expect(counts.get("b1c3")).toBeUndefined();
		expect(counts.get("e2e4")).toBe(500);
	});
	it("falls back to the base policy when nothing scored carries p ≥ minProb", () => {
		const maia = policy([
			["b1c3", 0.999],
			["e2e4", 0.001],
		]);
		const m = selectMove(FOUR, ctx({ maia, rng: createRng("floor") }), flatPrior(FOUR));
		expect(m.source).not.toBe("maia");
		expect(["sampled", "blunder"]).toContain(m.source);
		expect(m.rationale.join(" ")).toContain(
			`no scored candidate at p ≥ ${MAIA.minProb}, base policy`
		);
		expect(m.rationale.join(" ")).toContain("sampled:");
	});
	it("falls back when the rails leave nothing to draw from", () => {
		const lines = [line(START, "e2e4", { cp: 50 }, 1), line(START, "f2f3", { cp: -800 }, 2)];
		// e2e4 is scored but has no Maia mass; f2f3 has it all and is over the cap.
		const maia = policy([["f2f3", 1]]);
		const m = selectMove(lines, ctx({ maia, rng: createRng("empty") }), flatPrior(lines));
		expect(m.source).not.toBe("maia");
		expect(m.uci).toBe("e2e4");
	});
});

describe("selectMove — Maia scope (f)(g)", () => {
	it("(f) at LIMITS.eloMax the Maia context is ignored: same seed, same move as before", () => {
		const targetElo = LIMITS.eloMax;
		const without = selectMove(FOUR, ctx({ targetElo, rng: createRng(7) }), flatPrior(FOUR));
		const withMaia = selectMove(
			FOUR,
			ctx({ targetElo, maia: MAIA_FOUR, rng: createRng(7) }),
			flatPrior(FOUR)
		);
		expect(withMaia).toEqual(without);
		expect(withMaia.source).not.toBe("maia");
		expect(withMaia.rationale.join(" ")).not.toContain("maia");
	});
	// Owner, 2026-09-15: one division at the Maia cutoff. This case pinned the engine-pool prior over
	// (3000, 3200]; the band is removed, so above `MAIA.eloMax` the Maia context is ignored outright.
	it("(f) above MAIA.eloMax the Maia context is ignored: same seed, same move as without it", () => {
		for (const targetElo of [MAIA.eloMax + 1, 3100, 3200]) {
			const without = selectMove(FOUR, ctx({ targetElo, rng: createRng(7) }), flatPrior(FOUR));
			const m = selectMove(
				FOUR,
				ctx({ targetElo, maia: MAIA_FOUR, rng: createRng(7) }),
				flatPrior(FOUR)
			);
			expect(m).toEqual(without);
			expect(m.source).not.toBe("maia");
			expect(m.rationale.join(" ")).not.toContain("maia");
		}
	});
	it("(f) just below the ceiling Maia decides — the target Elo alone is the switch", () => {
		const on = selectMove(FOUR, ctx({ targetElo: 2599, maia: MAIA_FOUR }), flatPrior(FOUR));
		expect(on.source).toBe("maia");
	});
	it("(f) every selection mode is Maia's below 2600", () => {
		for (const selectionMode of ["engine-elo", "persona-sampling", "hybrid"] as const) {
			const m = selectMove(
				FOUR,
				ctx({ selectionMode, engineBestmove: "c2c4", maia: MAIA_FOUR, rng: createRng(5) }),
				flatPrior(FOUR)
			);
			expect(m.source).toBe("maia");
		}
	});
	it("(g) an immediate or forced mate still wins over Maia", () => {
		const fen = "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1";
		const immediate = [line(fen, "g6g5", { cp: 1500 }, 1), line(fen, "g6g7", { mate: 1 }, 2)];
		const m1 = selectMove(
			immediate,
			ctx({
				fen,
				maia: policy([
					["g6g5", 0.95],
					["g6g7", 0.05],
				]),
			}),
			flatPrior(immediate)
		);
		expect(m1.uci).toBe("g6g7");
		expect(m1.source).toBe("mate");
		// H9: a mate within `mateInMax` at a rating ≥ `mateAlwaysElo`; the ramp and the deeper
		// mates' fall-through are pinned in `selector-rails.test.ts`.
		const forced = [line(START, "e2e4", { cp: 700 }, 1), line(START, "d2d4", { mate: 3 }, 2)];
		const m2 = selectMove(
			forced,
			ctx({
				maia: policy([
					["e2e4", 0.95],
					["d2d4", 0.05],
				]),
			}),
			flatPrior(forced)
		);
		expect(m2.uci).toBe("d2d4");
		expect(m2.source).toBe("mate");
	});
	it("the opponent-clock-pressure reduction reaches the Maia loss cap through E", () => {
		const bad = line(START, "f2f3", { cp: -800 }, 5);
		const maia = policy([
			["f2f3", 0.9],
			["e2e4", 0.1],
		]);
		// E ≈ 1500 − 350·rush drops under 1400 in an opponent-only race: the 800–1400 ramp lets more through.
		const clocks = { baseMs: 180_000, incrementMs: 0, myClockMs: 90_000, oppClockMs: 1_000 };
		const m = selectMove(
			[...FOUR, bad],
			ctx({ ...clocks, maia, rng: createRng("pressure") }),
			flatPrior(FOUR)
		);
		expect(m.rationale.join(" ")).toContain("opponent clock pressure");
		expect(m.rationale.join(" ")).not.toContain("rush");
		expect(m.rationale.join(" ")).toMatch(/E=1\d{3}/);
	});
});

describe("selectMove — Maia accounting (h)", () => {
	it("source is 'maia', quality is a comparable search sample, and the streak follows the engine rank", () => {
		const state: SelectionState = createSelectionState();
		const rng = createRng("accounting");
		let ranks = 0;
		for (let i = 0; i < 40; i++) {
			const before = state.top1Streak;
			const m = selectMove(FOUR, ctx({ maia: MAIA_FOUR, rng, state }), flatPrior(FOUR));
			expect(m.source).toBe("maia");
			expect(m.quality).toEqual({ kind: "search", eligible: true, depth: 20, candidates: 4 });
			expect(m.cpLoss).toBe(50 - (FOUR[m.rankInLines - 1]?.score.cp ?? Number.NaN));
			expect(state.top1Streak).toBe(m.rankInLines === 1 ? before + 1 : 0);
			expect(state.previousOwnMoves[state.previousOwnMoves.length - 1]).toBe(m.uci);
			expect(state.previousOwnMoves.length).toBeLessThanOrEqual(4);
			ranks += m.rankInLines;
		}
		expect(ranks).toBeGreaterThan(40);
		expect(state.blunderDamperLeft).toBe(0);
	});
	it("an injected-blunder damper still counts down under Maia and no blunder is ever injected", () => {
		const state = { ...createSelectionState(), blunderDamperLeft: 2 };
		const rng = createRng("damper");
		for (let i = 0; i < 200; i++) {
			const m = selectMove(
				FOUR,
				ctx({ maia: MAIA_FOUR, rng, state, blunderScale: 2 }),
				flatPrior(FOUR)
			);
			expect(m.source).toBe("maia");
		}
		expect(state.blunderDamperLeft).toBe(0);
	});
});
