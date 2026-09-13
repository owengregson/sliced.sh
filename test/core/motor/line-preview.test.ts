// test/core/motor/line-preview.test.ts — the seeded line-preview planner (`LINE_PREVIEW`): who
// gets a preview, what it draws, and that the whole gesture always fits the window it is charged to.
import { describe, expect, it } from "bun:test";
import { LINE_PREVIEW, MOTOR_DEFAULTS } from "@core/motor/constants";
import {
	type LinePreviewInput,
	legalPlies,
	lineActivityNear,
	linePreviewBudgetMs,
	linePreviewEligibility,
	linePreviewProbability,
	planLinePreview,
} from "@core/motor/line-preview";
import { createRng } from "@core/rng";
import type { MoveWindowBudget } from "@typedefs/timing";
import { geometry } from "./fixtures";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const PV1 = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"];
const PV2 = ["d2d4", "d7d5", "c2c4"];
const LINES = [{ pvUci: PV1 }, { pvUci: PV2 }, { pvUci: ["g1f3"] }];

/** A long-think window: orientation 500, scan 3000, decision 7500, approach 1000 (think 12 s). */
function window(scanMs = 3000, decisionMs = 7500): MoveWindowBudget {
	return { orientationMs: 500, scanMs, previewMs: 0, decisionMs, approachMs: 1000 };
}

function input(over: Partial<LinePreviewInput> = {}): LinePreviewInput {
	return {
		fen: START_FEN,
		chosenUci: "e2e4",
		lines: LINES,
		timing: { mode: "long", thinkMs: 12_000, window: window(), features: {} },
		myClockMs: 300_000,
		profile: MOTOR_DEFAULTS,
		geometry: geometry(),
		cursor: { x: 900, y: 400 },
		seed: "game:fen:e2e4:line:paths",
		...over,
	};
}

describe("linePreviewProbability", () => {
	it("is 0 below the first knot, the knot values at the knots, linear between, flat beyond", () => {
		const [k0, k1, k2] = LINE_PREVIEW.probability as unknown as Array<[number, number]>;
		if (!k0 || !k1 || !k2) throw new Error("registry has fewer than three knots");
		expect(linePreviewProbability(k0[0] - 1)).toBe(0);
		expect(linePreviewProbability(k0[0])).toBeCloseTo(k0[1], 9);
		expect(linePreviewProbability(k1[0])).toBeCloseTo(k1[1], 9);
		expect(linePreviewProbability((k0[0] + k1[0]) / 2)).toBeCloseTo((k0[1] + k1[1]) / 2, 9);
		expect(linePreviewProbability(k2[0])).toBeCloseTo(k2[1], 9);
		expect(linePreviewProbability(k2[0] * 10)).toBeCloseTo(k2[1], 9);
		// monotone non-decreasing over the whole range
		let prev = 0;
		for (let t = 0; t <= k2[0] * 2; t += 250) {
			const p = linePreviewProbability(t);
			expect(p).toBeGreaterThanOrEqual(prev);
			prev = p;
		}
	});
});

describe("legalPlies", () => {
	it("replays the PV and stops at the first illegal ply", () => {
		expect(legalPlies(START_FEN, PV1).map((p) => p.uci)).toEqual(PV1);
		expect(legalPlies(START_FEN, ["e2e4", "e7e5", "e4e5"]).map((p) => p.uci)).toEqual([
			"e2e4",
			"e7e5",
		]);
		expect(legalPlies(START_FEN, ["e2e5"])).toEqual([]);
		expect(legalPlies(START_FEN, ["zz", "e2e4"])).toEqual([]);
		expect(legalPlies("not a fen", PV1)).toEqual([]);
	});
});

describe("linePreviewEligibility", () => {
	it("passes a long, comfortable, searched move whose PV is long enough", () => {
		expect(linePreviewEligibility(input())).toEqual({ ok: true });
	});

	it("refuses premove / instant modes, urgent plans, entered premoves, short thinks and low clocks", () => {
		const t = input().timing;
		const at = (over: Partial<LinePreviewInput>) => linePreviewEligibility(input(over));
		expect(at({ timing: { ...t, mode: "premove" } })).toMatchObject({ ok: false, reason: "mode" });
		expect(at({ timing: { ...t, mode: "instant" } })).toMatchObject({ ok: false, reason: "mode" });
		expect(at({ timing: { ...t, features: { clockRace: 1 } } })).toMatchObject({
			ok: false,
			reason: "urgent",
		});
		expect(at({ timing: { ...t, features: { loneKing: 1 } } })).toMatchObject({
			ok: false,
			reason: "urgent",
		});
		expect(at({ premove: true })).toMatchObject({ ok: false, reason: "premove" });
		expect(at({ timing: { ...t, thinkMs: LINE_PREVIEW.minThinkMs - 1 } })).toMatchObject({
			ok: false,
			reason: "think",
		});
		expect(at({ myClockMs: LINE_PREVIEW.minClockMs - 1 })).toMatchObject({
			ok: false,
			reason: "clock",
		});
		expect(at({ mode: "off" })).toMatchObject({ ok: false, reason: "off" });
	});

	it("refuses a move that is not the head of any line, or whose line is too short to draw", () => {
		expect(linePreviewEligibility(input({ chosenUci: "a2a3" }))).toMatchObject({
			ok: false,
			reason: "no-line",
		});
		expect(
			linePreviewEligibility(input({ chosenUci: "g1f3", lines: [{ pvUci: ["g1f3"] }] }))
		).toMatchObject({ ok: false, reason: "no-line" });
		// a PV whose second ply is illegal is a one-ply line
		expect(linePreviewEligibility(input({ lines: [{ pvUci: ["e2e4", "e2e4"] }] }))).toMatchObject({
			ok: false,
			reason: "no-line",
		});
	});
});

describe("activity near the opponent's last-moved piece", () => {
	it("lineActivityNear counts the plies touching squares within the radius, 0 without a last move", () => {
		const plies = legalPlies(START_FEN, PV2); // d2d4 d7d5 c2c4
		expect(lineActivityNear(plies, undefined)).toBe(0);
		expect(lineActivityNear(plies, "d5")).toBe(3); // d4, d5, c4 all within 2 of d5
		expect(lineActivityNear(plies, "h8")).toBe(0);
		expect(lineActivityNear(legalPlies(START_FEN, PV1), "h8")).toBe(0);
	});

	it("a second line is more likely, and drawn by activity, when an alternative works around that piece", () => {
		const long = input({
			mode: "force",
			timing: { mode: "long", thinkMs: 20_000, window: window(2000, 16_000), features: {} },
		});
		const count = (lastMoveTo: LinePreviewInput["lastMoveTo"]): number => {
			let seen = 0;
			for (let s = 0; s < 300; s++) {
				const plan = planLinePreview(
					lastMoveTo ? { ...long, lastMoveTo } : long,
					createRng(`near-${s}`)
				);
				if (plan && plan.lines.length === 2) seen += 1;
			}
			return seen;
		};
		const far = count("h8");
		const near = count("d5");
		expect(near).toBeGreaterThan(far * 1.5);
		expect(near / 300).toBeGreaterThan(LINE_PREVIEW.nearSecondLineProb * 0.7);
		expect(far / 300).toBeLessThan(LINE_PREVIEW.secondLineProb * 1.6);
	});
});

describe("planLinePreview", () => {
	it("forced on: draws 3–7 plies of the chosen move's PV in order, each a from→to arrow, and fits the budget", () => {
		const plan = planLinePreview(input({ mode: "force" }), createRng("seed-1"));
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.seed).toBe("game:fen:e2e4:line:paths");
		const first = plan.lines[0];
		expect(first).toBeDefined();
		if (!first) return;
		expect(first.uci).toBe("e2e4");
		expect(first.beforeMs).toBe(0);
		expect(first.arrows.length).toBeGreaterThanOrEqual(LINE_PREVIEW.plies[0]);
		expect(first.arrows.length).toBeLessThanOrEqual(LINE_PREVIEW.plies[1]);
		first.arrows.forEach((a, i) => {
			expect(`${a.from}${a.to}`).toBe(PV1[i] as string);
			expect(a.prePressMs).toBeGreaterThanOrEqual(LINE_PREVIEW.prePressMs[0]);
			expect(a.prePressMs).toBeLessThanOrEqual(LINE_PREVIEW.prePressMs[1]);
			expect(a.pressToDragMs).toBeGreaterThanOrEqual(LINE_PREVIEW.pressToDragMs[0]);
			expect(a.pressToDragMs).toBeLessThanOrEqual(LINE_PREVIEW.pressToDragMs[1]);
			expect(a.settleMs).toBeGreaterThanOrEqual(LINE_PREVIEW.releaseSettleMs[0]);
			expect(a.settleMs).toBeLessThanOrEqual(LINE_PREVIEW.releaseSettleMs[1]);
			const last = i === first.arrows.length - 1;
			const range = last ? LINE_PREVIEW.afterLineMs : LINE_PREVIEW.betweenArrowsMs;
			expect(a.afterMs).toBeGreaterThanOrEqual(range[0]);
			expect(a.afterMs).toBeLessThanOrEqual(range[1]);
			expect(a.estimateMs).toBeGreaterThan(a.prePressMs + a.pressToDragMs + a.settleMs + a.afterMs);
		});
		const arrowsMs = first.arrows.reduce((s, a) => s + a.estimateMs, 0);
		expect(first.estimateMs).toBeCloseTo(arrowsMs, 6);
		const total = plan.lines.reduce((s, l) => s + l.estimateMs, 0) + plan.restBeforeApproachMs;
		expect(plan.reserveMs).toBeCloseTo(total, 6);
		expect(plan.reserveMs + LINE_PREVIEW.marginMs).toBeLessThanOrEqual(
			linePreviewBudgetMs(input().timing.window)
		);
	});

	it("is deterministic per seed", () => {
		const a = planLinePreview(input({ mode: "force" }), createRng("seed-7"));
		const b = planLinePreview(input({ mode: "force" }), createRng("seed-7"));
		expect(a).toEqual(b);
	});

	it("a second line, when drawn, is another candidate's PV starting with a different move, never longer than the first", () => {
		// Two lines are ~10 s of gesture, so only a long window (24 s think here) ever holds both:
		// at 12 s the fit rule drops the second line first, every time.
		const long = input({
			mode: "force",
			timing: { mode: "long", thinkMs: 24_000, window: window(6000, 16_000), features: {} },
		});
		let seen = 0;
		for (let s = 0; s < 200; s++) {
			const plan = planLinePreview(long, createRng(`second-${s}`));
			if (!plan) continue;
			expect(plan.lines.length).toBeLessThanOrEqual(2);
			const [first, second] = plan.lines;
			if (!first || !second) continue;
			seen += 1;
			expect(second.uci).toBe("d2d4");
			expect(second.beforeMs).toBeGreaterThanOrEqual(LINE_PREVIEW.betweenLinesMs[0]);
			expect(second.beforeMs).toBeLessThanOrEqual(LINE_PREVIEW.betweenLinesMs[1]);
			expect(second.arrows.length).toBeGreaterThanOrEqual(LINE_PREVIEW.plies[0]);
			expect(second.arrows.length).toBeLessThanOrEqual(first.arrows.length);
			second.arrows.forEach((a, i) => {
				expect(`${a.from}${a.to}`).toBe(PV2[i] as string);
			});
		}
		// `secondLineProb` of the forced plans, give or take: some, not most
		expect(seen).toBeGreaterThan(200 * LINE_PREVIEW.secondLineProb * 0.5);
		expect(seen).toBeLessThan(200 * LINE_PREVIEW.secondLineProb * 1.6);
	});

	it("shortens the line, then drops it, when the window cannot hold the gesture with margin", () => {
		// A budget that holds only two arrows: every plan that fits is exactly the minimum length …
		const tight = window(600, 3200);
		for (let s = 0; s < 40; s++) {
			const plan = planLinePreview(
				input({
					mode: "force",
					timing: { mode: "long", thinkMs: 6000, window: tight, features: {} },
				}),
				createRng(`tight-${s}`)
			);
			if (!plan) continue;
			expect(plan.lines).toHaveLength(1);
			expect(plan.lines[0]?.arrows).toHaveLength(LINE_PREVIEW.plies[0]);
			expect(plan.reserveMs + LINE_PREVIEW.marginMs).toBeLessThanOrEqual(linePreviewBudgetMs(tight));
		}
		// … and a window with no room at all never previews, forced or not.
		const none = window(200, 900);
		for (let s = 0; s < 40; s++) {
			expect(
				planLinePreview(
					input({
						mode: "force",
						timing: { mode: "long", thinkMs: 6000, window: none, features: {} },
					}),
					createRng(`none-${s}`)
				)
			).toBeNull();
		}
	});

	it("in `auto` the rate over many seeds follows the think-time knots; `off` never previews", () => {
		const rate = (thinkMs: number): number => {
			let n = 0;
			const trials = 600;
			for (let s = 0; s < trials; s++) {
				const plan = planLinePreview(
					input({ timing: { mode: "long", thinkMs, window: window(), features: {} } }),
					createRng(`auto-${thinkMs}-${s}`)
				);
				if (plan) n += 1;
			}
			return n / trials;
		};
		for (const thinkMs of [6000, 10_000, 20_000]) {
			const p = linePreviewProbability(thinkMs);
			const r = rate(thinkMs);
			// ±3σ of a binomial at n = 600 (σ ≤ 0.021)
			expect(Math.abs(r - p)).toBeLessThanOrEqual(0.065);
		}
		expect(rate(20_000)).toBeGreaterThan(rate(6000));
		for (let s = 0; s < 50; s++)
			expect(planLinePreview(input({ mode: "off" }), createRng(`off-${s}`))).toBeNull();
	});

	it("never plans on a premove, an instant plan, a short think or a time-trouble clock, even when forced", () => {
		const t = input().timing;
		const cases: Array<Partial<LinePreviewInput>> = [
			{ timing: { ...t, mode: "premove" } },
			{ timing: { ...t, mode: "instant" } },
			{ timing: { ...t, features: { clockRace: 1 } } },
			{ premove: true },
			{ timing: { ...t, thinkMs: LINE_PREVIEW.minThinkMs - 1 } },
			{ myClockMs: LINE_PREVIEW.minClockMs - 1 },
		];
		for (const c of cases)
			expect(planLinePreview(input({ mode: "force", ...c }), createRng("forced"))).toBeNull();
	});
});
