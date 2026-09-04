// test/core/strength/blunder-model.test.ts
import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { blunderProbability, drawTargetLoss, pickBlunder } from "@core/strength/blunder-model";
import { b0For } from "@core/strength/elo-map";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { ctx, flatPrior, line, START } from "./helpers";

/** Best +50, then −20, −60, −220: one candidate (−220) sits in the ≥ 0.10 loss band. */
const FOUR = [
	line(START, "e2e4", { cp: 50 }, 1),
	line(START, "d2d4", { cp: -20 }, 2),
	line(START, "g1f3", { cp: -60 }, 3),
	line(START, "f2f3", { cp: -220 }, 4),
];

describe("blunderProbability b(E, ctx)", () => {
	it("is b0(E)·f_clock·f_complexity·blunderScale with the streak damper", () => {
		const state = createSelectionState();
		expect(
			blunderProbability(1200, { myClockMs: 60_000, cpStd: 50, blunderScale: 1, state })
		).toBeCloseTo(0.055, 12);
		expect(
			blunderProbability(1200, { myClockMs: 60_000, cpStd: 50, blunderScale: 5, state })
		).toBeCloseTo(0.275, 12);
		// f_clock: 10 s left → 1 + 1.5·0.5 = 1.75
		expect(
			blunderProbability(1200, { myClockMs: 10_000, cpStd: 50, blunderScale: 1, state })
		).toBeCloseTo(0.055 * 1.75, 12);
		// f_clock saturates at 2.5 at 0 s
		expect(blunderProbability(1200, { myClockMs: 0, cpStd: 50, blunderScale: 1, state })).toBeCloseTo(
			0.055 * 2.5,
			12
		);
		// f_complexity: std ≥ 150 → ×1.6
		expect(
			blunderProbability(1200, { myClockMs: 60_000, cpStd: 150, blunderScale: 1, state })
		).toBeCloseTo(0.055 * 1.6, 12);
		// damper ×0.3 while blunderDamperLeft > 0
		const damped = { ...createSelectionState(), blunderDamperLeft: 2 };
		expect(
			blunderProbability(1200, { myClockMs: 60_000, cpStd: 50, blunderScale: 1, state: damped })
		).toBeCloseTo(0.055 * 0.3, 12);
		expect(blunderProbability(2500, { myClockMs: 60_000, cpStd: 0, blunderScale: 0, state })).toBe(0);
	});
});

describe("drawTargetLoss", () => {
	it("draws 65 % mistakes in U(0.10, 0.30) and 35 % blunders in U(0.30, 0.70)", () => {
		const rng = createRng("target");
		let mistakes = 0;
		const n = 20_000;
		for (let i = 0; i < n; i++) {
			const t = drawTargetLoss(rng);
			expect(t.target).toBeGreaterThanOrEqual(0.1);
			expect(t.target).toBeLessThan(0.7);
			if (t.kind === "mistake") {
				mistakes++;
				expect(t.target).toBeLessThan(0.3);
			} else expect(t.target).toBeGreaterThanOrEqual(0.3);
		}
		expect(Math.abs(mistakes / n - 0.65)).toBeLessThan(0.015);
	});
});

describe("pickBlunder", () => {
	it("picks the candidate whose loss is nearest the target, weighted by prior", () => {
		const cands = [
			{ uci: "a", loss: 0.12, prior: 1 },
			{ uci: "b", loss: 0.3, prior: 1 },
			{ uci: "c", loss: 0.5, prior: 1 },
		];
		expect(pickBlunder(cands, 0.28)?.uci).toBe("b");
		expect(pickBlunder(cands, 0.6)?.uci).toBe("c");
		// A natural-looking (high prior) move wins a near-tie.
		const weighted = [
			{ uci: "a", loss: 0.2, prior: 4 },
			{ uci: "b", loss: 0.3, prior: 1 },
		];
		expect(pickBlunder(weighted, 0.27)?.uci).toBe("a");
		expect(pickBlunder([], 0.3)).toBeNull();
	});
});

describe("selectMove — blunder channel (d)", () => {
	it("blunderScale = 5 at E = 1200: injected-blunder rate within ±20 % of 5·b0(1200) over 40 000 samples", () => {
		const rng = createRng("blunder-rate");
		const prior = flatPrior(FOUR);
		let injected = 0;
		let cpLossSum = 0;
		const n = 40_000;
		for (let i = 0; i < n; i++) {
			const c = ctx({ targetElo: 1200, blunderScale: 5, rng, state: createSelectionState() });
			const m = selectMove(FOUR, c, prior);
			if (m.source === "blunder") {
				injected++;
				cpLossSum += m.cpLoss;
			}
		}
		// Injected moves come from the ≥ 0.10 loss band: mostly f2f3 (270 cp), sometimes g1f3 after jitter.
		expect(cpLossSum / injected).toBeGreaterThan(150);
		const expected = 5 * b0For(1200);
		expect(expected).toBeCloseTo(0.275, 12);
		const rate = injected / n;
		expect(rate).toBeGreaterThanOrEqual(expected * 0.8);
		expect(rate).toBeLessThanOrEqual(expected * 1.2);
	});
	it("falls through to the base policy when no candidate loses ≥ 0.10", () => {
		const CLOSE = [line(START, "e2e4", { cp: 20 }, 1), line(START, "d2d4", { cp: 10 }, 2)];
		const rng = createRng("no-pool");
		let channelDraws = 0;
		for (let i = 0; i < 4000; i++) {
			// E = 2400: σ = 8 cp, so the 10 cp gap never reaches the 0.10 loss band; b = 0.005·2.5·5.
			const c = ctx({
				targetElo: 2400,
				blunderScale: 5,
				myClockMs: 0,
				rng,
				state: createSelectionState(),
			});
			const m = selectMove(CLOSE, c, flatPrior(CLOSE));
			expect(m.source).toBe("sampled");
			if (m.rationale.some((r) => r.startsWith("blunder: no candidate"))) channelDraws++;
		}
		expect(channelDraws).toBeGreaterThan(0);
	});
	it("arms the ×0.3 damper for the 3 moves after an injected blunder", () => {
		const rng = createRng("damper");
		const state = createSelectionState();
		let first: number | null = null;
		for (let i = 0; i < 500 && first === null; i++) {
			const m = selectMove(
				FOUR,
				ctx({ targetElo: 1200, blunderScale: 5, rng, state }),
				flatPrior(FOUR)
			);
			if (m.source === "blunder") first = i;
		}
		expect(first).not.toBeNull();
		expect(state.blunderDamperLeft).toBe(3);
		const c = ctx({ targetElo: 1200, blunderScale: 0, rng, state });
		selectMove(FOUR, c, flatPrior(FOUR));
		expect(state.blunderDamperLeft).toBe(2);
		selectMove(FOUR, c, flatPrior(FOUR));
		selectMove(FOUR, c, flatPrior(FOUR));
		expect(state.blunderDamperLeft).toBe(0);
		selectMove(FOUR, c, flatPrior(FOUR));
		expect(state.blunderDamperLeft).toBe(0);
	});
	it("blunderScale = 0 never injects", () => {
		const rng = createRng("zero");
		for (let i = 0; i < 3000; i++) {
			const c = ctx({
				targetElo: 900,
				blunderScale: 0,
				myClockMs: 0,
				rng,
				state: createSelectionState(),
			});
			expect(selectMove(FOUR, c, flatPrior(FOUR)).source).not.toBe("blunder");
		}
	});
});
