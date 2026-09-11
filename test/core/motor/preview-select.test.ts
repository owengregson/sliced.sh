// test/core/motor/preview-select.test.ts — §9.3a pure probability and preview planning.
import { describe, expect, it } from "bun:test";
import { MOTOR_DEFAULTS, PREVIEW } from "@core/motor/constants";
import { planPreview, previewProbability } from "@core/motor/preview-select";
import { createRng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { dist, geometry, inside, squareRect } from "./fixtures";

const ctx = (over: Partial<Parameters<typeof previewProbability>[0]> = {}) => ({
	persona: "balanced" as const,
	nReasonable: 3,
	thinkMs: 4000,
	mode: "normal" as const,
	myClockMs: 60_000,
	previewScale: 1,
	...over,
});

describe("previewProbability", () => {
	it("follows base · f · g with the cap, floors and gates", () => {
		expect(previewProbability(ctx())).toBeCloseTo(0.07 * 1.7, 9);
		expect(previewProbability(ctx({ persona: "cautious" }))).toBeCloseTo(0.04 * 1.7, 9);
		expect(previewProbability(ctx({ persona: "aggressive", nReasonable: 1 }))).toBeCloseTo(0.1, 9);
		expect(previewProbability(ctx({ persona: "blitz", nReasonable: 2 }))).toBeCloseTo(0.05 * 1.35, 9);
		expect(previewProbability(ctx({ thinkMs: 1199 }))).toBe(0);
		expect(previewProbability(ctx({ thinkMs: 2600 }))).toBeCloseTo(0.07 * 1.7 * 0.5, 9);
		expect(previewProbability(ctx({ thinkMs: 10_000 }))).toBeCloseTo(0.07 * 1.7 * 1.6, 9);
		expect(previewProbability(ctx({ thinkMs: 60_000 }))).toBeCloseTo(0.07 * 1.7 * 1.6, 9);
		expect(previewProbability(ctx({ persona: "aggressive", nReasonable: 8, thinkMs: 10_000 }))).toBe(
			PREVIEW.cap
		);
		expect(previewProbability(ctx({ mode: "premove" }))).toBe(0);
		expect(previewProbability(ctx({ mode: "instant" }))).toBe(0);
		expect(previewProbability(ctx({ mode: "long" }))).toBeGreaterThan(0);
		expect(previewProbability(ctx({ myClockMs: 14_999 }))).toBe(0);
		expect(previewProbability(ctx({ previewScale: 0 }))).toBe(0);
		expect(previewProbability(ctx({ previewScale: 2 }))).toBeCloseTo(0.07 * 1.7 * 2, 9);
	});
});

const DESTS: Partial<Record<Square, Square[]>> = {
	e1: ["f1", "g1", "h1"],
	h1: ["g1", "f1"],
	e2: ["e3", "e4"],
	g1: ["f3", "h3"],
	d2: ["d3", "d4"],
};
const legalDestinations = (sq: Square): Square[] => DESTS[sq] ?? [];
const GEO = geometry();

function input(over: Partial<Parameters<typeof planPreview>[0]> = {}) {
	return {
		cursor: { x: 420, y: 720 },
		candidates: [
			{ from: "e2" as Square, to: "e4" as Square, probability: 0.6, uci: "e2e4" },
			{ from: "g1" as Square, to: "f3" as Square, probability: 0.3, uci: "g1f3" },
			{ from: "d2" as Square, to: "d4" as Square, probability: 0.1, uci: "d2d4" },
		],
		committed: { from: "e2" as Square, to: "e4" as Square },
		geometry: GEO,
		legalDestinations,
		profile: MOTOR_DEFAULTS,
		maxMs: 5000,
		...over,
	};
}

describe("planPreview", () => {
	it("previews a different candidate ~80 % of the time, from the runner-up distribution", () => {
		let different = 0;
		let g1 = 0;
		let n = 0;
		for (let seed = 0; seed < 2000; seed++) {
			const pv = planPreview(input(), createRng(seed));
			if (!pv) continue;
			n++;
			if (!pv.isCommittedPiece) {
				different++;
				if (pv.piece === "g1") g1++;
			} else expect(pv.resolve).toBe("deselect");
			expect(pv.totalAfterApproachMs).toBeGreaterThanOrEqual(pv.holdMs + pv.dwellMs);
			expect(pv.dwellMs).toBeGreaterThanOrEqual(PREVIEW.dwellMs[0]);
			expect(pv.dwellMs).toBeLessThanOrEqual(PREVIEW.dwellMs[1]);
		}
		expect(n).toBeGreaterThan(1900);
		expect(different / n).toBeGreaterThan(0.74);
		expect(different / n).toBeLessThan(0.86);
		expect(g1 / different).toBeGreaterThan(0.65);
	});

	it("uses deselect when the committed piece is a legal destination of the previewed piece (castling)", () => {
		for (let seed = 0; seed < 200; seed++) {
			const pv = planPreview(
				input({
					candidates: [
						{ from: "h1", to: "h3", probability: 0.7, uci: "h1h3" },
						{ from: "e1", to: "g1", probability: 0.3, uci: "e1g1" },
					],
					committed: { from: "h1", to: "h3" },
				}),
				createRng(seed)
			);
			if (!pv) continue;
			if (pv.piece === "e1") {
				expect(pv.resolve).toBe("deselect");
				expect(legalDestinations("e1")).not.toContain(pv.deselect!.square);
			}
		}
	});

	it("honours the exclude list and returns null when nothing is previewable", () => {
		for (let seed = 0; seed < 100; seed++) {
			const pv = planPreview(input({ exclude: ["g1", "d2"] }), createRng(seed));
			if (pv) expect(pv.piece).toBe("e2");
		}
		expect(planPreview(input({ exclude: ["g1", "d2", "e2"] }), createRng(1))).toBeNull();
		expect(planPreview(input({ maxMs: 200 }), createRng(1))).toBeNull();
		expect(planPreview(input({ legalDestinations: () => [] as Square[] }), createRng(1))).toBeNull();
	});

	it("never previews a legal destination of a piece still selected from an earlier preview", () => {
		// e1 (king) is selected from a switch-resolved first preview; its destinations include h1.
		for (let seed = 0; seed < 300; seed++) {
			const pv = planPreview(
				input({
					candidates: [
						{ from: "h1", to: "h3", probability: 0.5, uci: "h1h3" },
						{ from: "d2", to: "d4", probability: 0.3, uci: "d2d4" },
						{ from: "e1", to: "g1", probability: 0.2, uci: "e1g1" },
					],
					committed: { from: "d2", to: "d4" },
					exclude: ["e1"],
					selected: "e1",
				}),
				createRng(seed)
			);
			if (!pv) continue;
			expect(legalDestinations("e1")).not.toContain(pv.piece);
			expect(pv.piece).toBe("d2");
		}
		// With every candidate banned, nothing is previewed.
		expect(
			planPreview(
				input({
					candidates: [{ from: "h1", to: "h3", probability: 1, uci: "h1h3" }],
					committed: { from: "h1", to: "h3" },
					selected: "e1",
				}),
				createRng(1)
			)
		).toBeNull();
	});

	it("uses occupancy to deselect on empty squares first, labelling own-piece fallbacks truthfully", () => {
		const own = new Set<Square>(["e1", "h1", "e2", "g1", "d2", "a1", "b1", "c1"]);
		const enemy = new Set<Square>(["e8", "d8", "a7"]);
		const occupancy = (sq: Square): "own" | "enemy" | "empty" =>
			own.has(sq) ? "own" : enemy.has(sq) ? "enemy" : "empty";
		let deselects = 0;
		for (let seed = 0; seed < 400; seed++) {
			const pv = planPreview(input({ occupancy }), createRng(seed));
			if (!pv?.deselect) continue;
			deselects++;
			expect(pv.resolve).toBe("deselect");
			expect(pv.deselect.occupancy).toBe("empty");
			expect(occupancy(pv.deselect.square)).toBe("empty");
		}
		expect(deselects).toBeGreaterThan(50);
		// Only own immobile pieces remain → a truthful "switch-to-idle" on a moveless own piece.
		const crowded = (): "own" | "enemy" | "empty" => "own";
		const dests = (sq: Square): Square[] => (sq === "e2" ? ["e3", "e4"] : sq === "g1" ? ["f3"] : []);
		let idle = 0;
		for (let seed = 0; seed < 100; seed++) {
			const pv = planPreview(
				input({ occupancy: crowded, legalDestinations: dests, exclude: ["g1", "d2"] }),
				createRng(seed)
			);
			if (!pv?.deselect) continue;
			idle++;
			expect(pv.resolve).toBe("switch-to-idle");
			expect(pv.deselect.occupancy).toBe("own");
			expect(dests(pv.deselect.square)).toEqual([]);
			expect(dests("e2")).not.toContain(pv.deselect.square);
		}
		expect(idle).toBeGreaterThan(20);
	});

	// `motor.pressHoldMs` lost its only assertion when the committed click-click form was removed
	// (a drag holds the button for the whole travel instead). It is still live production behaviour
	// here — the preview press and the deselect click are the two presses the page sees held — so
	// the floor and ceiling are pinned where they are now sampled.
	it("every preview press is held for a sampled `pressHoldMs`, deselect click included", () => {
		const [lo, hi] = MOTOR_DEFAULTS.pressHoldMs;
		let holds = 0;
		let deselects = 0;
		const seen = new Set<number>();
		for (let seed = 0; seed < 300; seed++) {
			const pv = planPreview(input(), createRng(seed));
			if (!pv) continue;
			holds += 1;
			seen.add(pv.holdMs);
			expect(pv.holdMs).toBeGreaterThanOrEqual(lo);
			expect(pv.holdMs).toBeLessThanOrEqual(hi);
			if (!pv.deselect) continue;
			deselects += 1;
			expect(pv.deselect.holdMs).toBeGreaterThanOrEqual(lo);
			expect(pv.deselect.holdMs).toBeLessThanOrEqual(hi);
		}
		expect(holds).toBeGreaterThan(100);
		expect(deselects).toBeGreaterThan(0);
		// sampled per press, not a constant
		expect(seen.size).toBeGreaterThan(holds / 2);
	});

	it("geometry: press on the piece, hover on a destination, release rules per style", () => {
		for (let seed = 0; seed < 300; seed++) {
			const pv = planPreview(input(), createRng(seed));
			if (!pv) continue;
			expect(inside(pv.press, squareRect(pv.piece))).toBe(true);
			expect(inside(pv.hoverPoint, squareRect(pv.hoverSquare))).toBe(true);
			expect(legalDestinations(pv.piece)).toContain(pv.hoverSquare);
			if (pv.style === "drag") expect(inside(pv.release, squareRect(pv.piece))).toBe(true);
			else expect(dist(pv.press, pv.release)).toBeLessThanOrEqual(2);
			const last = pv.hoverPath[pv.hoverPath.length - 1];
			if (last) expect(last).toMatchObject({ x: pv.hoverPoint.x, y: pv.hoverPoint.y });
		}
	});
});
