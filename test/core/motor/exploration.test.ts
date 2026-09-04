// test/core/motor/exploration.test.ts — Step 4 (§9.3 planner, §8.4b allocation, §9.3a preview bands).
import { describe, expect, it } from "bun:test";
import { MOTOR_DEFAULTS } from "@core/motor/constants";
import {
	actionDurationMs,
	type ExplorationCandidate,
	type ExplorationOptions,
	ExplorationPlanner,
	planDurationMs,
	restPoint,
} from "@core/motor/exploration";
import type { HandAction, Pt } from "@core/motor/types";
import { createRng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { BOARD, dist, geometry, inside, squareRect } from "./fixtures";

const CANDIDATES: ExplorationCandidate[] = [
	{ from: "e2", to: "e4", probability: 0.7, uci: "e2e4" },
	{ from: "g1", to: "f3", probability: 0.2, uci: "g1f3" },
	{ from: "d2", to: "d4", probability: 0.1, uci: "d2d4" },
];
const DESTS: Partial<Record<Square, Square[]>> = {
	e2: ["e3", "e4"],
	g1: ["f3", "h3"],
	d2: ["d3", "d4"],
	b1: ["a3", "c3"],
	c2: ["c3", "c4"],
};
const legalDestinations = (sq: Square): Square[] => DESTS[sq] ?? [];
const GEO = geometry();
const CURSOR: Pt = { x: 420, y: 720 };

function opts(over: Partial<ExplorationOptions> = {}): ExplorationOptions {
	return {
		thinkMs: 4000,
		mode: "normal",
		nReasonable: 3,
		myClockMs: 60_000,
		persona: "balanced",
		previewScale: 1,
		committed: { from: "e2", to: "e4" },
		legalDestinations,
		cursor: CURSOR,
		...over,
	};
}

const planner = new ExplorationPlanner();
const plan = (seed: number | string, waitMs = 4000, o: Partial<ExplorationOptions> = {}) =>
	planner.plan(waitMs, CANDIDATES, GEO, MOTOR_DEFAULTS, createRng(seed), opts(o));

function previewRate(
	n: number,
	waitMs: number,
	o: Partial<ExplorationOptions>,
	tag: string
): number {
	let hits = 0;
	for (let i = 0; i < n; i++)
		if (plan(`${tag}-${i}`, waitMs, o).some((a) => a.kind === "preview")) hits++;
	return hits / n;
}

function endOf(a: HandAction, prev: Pt): Pt {
	const last = a.path?.[a.path.length - 1];
	let end = last ? { x: last.x, y: last.y } : prev;
	const pv = a.preview;
	if (pv) {
		end = pv.hoverPoint;
		if (pv.deselect) end = pv.deselect.release;
	}
	return end;
}

describe("ExplorationPlanner.plan", () => {
	it("keeps the total ≤ waitMs − reactionMs and the actions continuous", () => {
		for (let seed = 0; seed < 300; seed++) {
			const actions = plan(seed);
			expect(actions.length).toBeGreaterThan(0);
			expect(planDurationMs(actions)).toBeLessThanOrEqual(4000 - MOTOR_DEFAULTS.reactionMs[0]);
			expect(actions[actions.length - 1]!.kind).toBe("rest");
			let cursor = CURSOR;
			const maxStep = (MOTOR_DEFAULTS.peakSpeedCapPxPerS * MOTOR_DEFAULTS.sampleIntervalMs) / 1000;
			for (const a of actions) {
				expect(actionDurationMs(a)).toBeGreaterThanOrEqual(0);
				const first = a.path?.[0];
				if (first) expect(dist(cursor, first)).toBeLessThanOrEqual(maxStep + 1);
				for (const p of a.path ?? []) {
					expect(Number.isInteger(p.x)).toBe(true);
					expect(p.dtMs).toBeGreaterThan(0);
				}
				cursor = endOf(a, cursor);
			}
		}
	});

	it("hovers prefer higher-probability candidates (≥ 60 % of first hovers on the top one)", () => {
		let hovers = 0;
		let top = 0;
		for (let seed = 0; seed < 1000; seed++) {
			const first = plan(`h${seed}`).find((a) => a.kind === "hover");
			if (!first?.rect) continue;
			hovers++;
			if (inside(first.target!, squareRect("e2"))) top++;
			expect(inside(first.target!, first.rect)).toBe(true);
		}
		expect(hovers).toBeGreaterThan(300);
		expect(top / hovers).toBeGreaterThanOrEqual(0.6);
	});

	it("uses only [rest] when the window is too short", () => {
		for (let seed = 0; seed < 50; seed++) {
			const actions = plan(seed, 300);
			expect(actions.length).toBe(1);
			expect(actions[0]!.kind).toBe("rest");
			expect(planDurationMs(actions)).toBeLessThanOrEqual(300);
		}
	});

	it("produces traces/feints toward the to-square without pressing, occasionally", () => {
		let traces = 0;
		for (let seed = 0; seed < 400; seed++)
			for (const a of plan(`t${seed}`)) {
				if (a.kind === "trace" || a.kind === "feint") traces++;
				expect(["rest", "hover", "trace", "feint", "drift", "preview"]).toContain(a.kind);
			}
		expect(traces).toBeGreaterThan(10);
	});

	describe("V2.1 preview selections (§9.3a)", () => {
		it("appears in 6–14 % of plans at thinkMs 4 000, n_reasonable 3, balanced", () => {
			const rate = previewRate(5000, 4000, {}, "band");
			expect(rate).toBeGreaterThanOrEqual(0.06);
			expect(rate).toBeLessThanOrEqual(0.14);
		});
		it("is 0 % at thinkMs 800, in premove/instant modes, in time trouble, or with scale 0", () => {
			expect(previewRate(400, 4000, { thinkMs: 800 }, "short")).toBe(0);
			expect(previewRate(400, 4000, { mode: "premove" }, "pre")).toBe(0);
			expect(previewRate(400, 4000, { mode: "instant" }, "inst")).toBe(0);
			expect(previewRate(400, 4000, { myClockMs: 14_999 }, "clock")).toBe(0);
			expect(previewRate(400, 4000, { previewScale: 0 }, "scale")).toBe(0);
		});
		it("rises with n_reasonable", () => {
			const r1 = previewRate(2500, 4000, { nReasonable: 1 }, "n1");
			const r5 = previewRate(2500, 4000, { nReasonable: 5 }, "n5");
			expect(r5).toBeGreaterThan(r1 * 1.5);
		});
		it("never presses a legal destination of the previewed piece and drags release on the origin", () => {
			let previews = 0;
			let drags = 0;
			let committedPiece = 0;
			for (let seed = 0; seed < 3000; seed++) {
				const actions = plan(`p${seed}`, 4500);
				const pvs = actions.filter((a) => a.kind === "preview");
				expect(pvs.length).toBeLessThanOrEqual(2);
				const pieces = new Set<string>();
				for (const a of pvs) {
					const pv = a.preview!;
					previews++;
					expect(pieces.has(pv.piece)).toBe(false);
					pieces.add(pv.piece);
					const dests = legalDestinations(pv.piece);
					expect(dests.length).toBeGreaterThan(0);
					expect(dests).toContain(pv.hoverSquare);
					expect(inside(pv.press, squareRect(pv.piece))).toBe(true);
					expect(inside(pv.hoverPoint, squareRect(pv.hoverSquare))).toBe(true);
					if (pv.style === "drag") {
						drags++;
						expect(inside(pv.release, squareRect(pv.piece))).toBe(true);
						const last = pv.dragPath![pv.dragPath!.length - 1]!;
						expect(last.x).toBe(pv.release.x);
						expect(last.y).toBe(pv.release.y);
						let far = 0;
						for (const p of pv.dragPath!) far = Math.max(far, dist(p, pv.press));
						expect(far).toBeGreaterThanOrEqual(6);
					} else {
						expect(dist(pv.press, pv.release)).toBeLessThanOrEqual(2);
					}
					if (pv.isCommittedPiece) {
						committedPiece++;
						expect(pv.piece).toBe("e2");
						expect(pv.resolve).toBe("deselect");
					} else {
						expect(pv.piece).not.toBe("e2");
					}
					if (pv.resolve === "switch") expect(dests).not.toContain("e2");
					else {
						const d = pv.deselect!;
						expect(dests).not.toContain(d.square);
						expect(d.square).not.toBe(pv.piece);
						expect(legalDestinations(d.square)).toEqual([]);
						expect(inside(d.press, squareRect(d.square))).toBe(true);
						expect(dist(d.press, d.release)).toBeLessThanOrEqual(2);
					}
					expect(a.dwellMs).toBe(pv.totalAfterApproachMs);
				}
			}
			expect(previews).toBeGreaterThan(100);
			expect(drags).toBeGreaterThan(5);
			expect(committedPiece / previews).toBeGreaterThan(0.1);
			expect(committedPiece / previews).toBeLessThan(0.35);
		});
	});
});

describe("restPoint", () => {
	it("rests on the anchor, near the clock or off-board depending on style", () => {
		const rng = createRng("rest");
		const anchor = { x: 300, y: 300 };
		for (let i = 0; i < 100; i++) {
			expect(dist(restPoint(GEO, "piece", anchor, rng), anchor)).toBeLessThan(40);
			const clock = restPoint(GEO, "clock", anchor, rng);
			expect(clock.x).toBeGreaterThan(BOARD.left + BOARD.width);
			expect(inside(restPoint(GEO, "offboard", anchor, rng), BOARD)).toBe(false);
			const mixed = restPoint(GEO, "mixed", null, rng);
			expect(Number.isInteger(mixed.x)).toBe(true);
		}
	});
});
