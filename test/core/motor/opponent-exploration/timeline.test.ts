import { describe, expect, it } from "bun:test";
import { MOTOR_DEFAULTS, OPPONENT_EXPLORATION as O } from "@core/motor/constants";
import { midpoint, validRect } from "@core/motor/geometry";
import { SpellTimeline } from "@core/motor/opponent-exploration/timeline";
import { createRng } from "@core/rng";
import { centre, geometry, squareRect } from "../fixtures";

const timeline = (total: number, over: { ownOnly?: boolean; previousTarget?: "e4" } = {}) =>
	new SpellTimeline(
		{
			geometry: geometry(),
			profile: MOTOR_DEFAULTS,
			cursor: { x: 50, y: 50 },
			...(over.previousTarget ? { previousTarget: over.previousTarget } : {}),
		},
		over.ownOnly === true,
		{ total, spent: 0, activeUntil: total },
		createRng("timeline")
	);

describe("SpellTimeline", () => {
	it("charges every action to the budget and moves the cursor with the hand", () => {
		const hand = timeline(10_000);
		expect(hand.visit("e4", "own", "hover", 400, "line")).toBe("done");
		expect(hand.lastTarget).toBe("e4");
		const spent = hand.actions.reduce(
			(t, a) => t + (a.path ?? []).reduce((s, p) => s + p.dtMs, 0) + a.dwellMs,
			0
		);
		expect(hand.budget.spent).toBeCloseTo(spent, 6);
		expect(hand.room()).toBeCloseTo(10_000 - spent, 6);
	});

	it("skips the square it is already on and the opponent's side under own-only", () => {
		expect(timeline(10_000, { previousTarget: "e4" }).visit("e4", "own", "hover", 400, "line")).toBe(
			"skipped"
		);
		const own = timeline(10_000, { ownOnly: true });
		expect(own.visit("e5", "opponent", "hover", 400, "line")).toBe("skipped");
		expect(own.actions).toHaveLength(0);
	});

	it("refuses a leg that would leave less than the minimum dwell", () => {
		const hand = timeline(O.minDwellMs);
		expect(hand.visit("h1", "own", "hover", 400, "line")).toBe("refused");
		expect(hand.actions).toHaveLength(0);
		expect(hand.budget.spent).toBe(0);
	});

	it("never rests past the spell's total", () => {
		const hand = timeline(500);
		hand.rest(300);
		hand.rest(300);
		expect(hand.budget.spent).toBe(500);
	});
});

describe("geometry helpers", () => {
	it("validRect rejects empty and non-finite rects", () => {
		expect(validRect(squareRect("a1"))).toBe(true);
		expect(validRect({ left: 0, top: 0, width: 0, height: 10 })).toBe(false);
		expect(validRect({ left: Number.NaN, top: 0, width: 10, height: 10 })).toBe(false);
	});

	it("midpoint is halfway between the centres", () => {
		const a = squareRect("a1");
		const b = squareRect("c3");
		const m = midpoint(a, b);
		expect(m.x).toBeCloseTo((centre(a).x + centre(b).x) / 2, 9);
		expect(m.y).toBeCloseTo((centre(a).y + centre(b).y) / 2, 9);
	});
});
