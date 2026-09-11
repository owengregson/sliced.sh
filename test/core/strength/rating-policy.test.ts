import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import { heuristicPrior } from "@core/strength/prior";
import type { EvalLine } from "@typedefs/engine";
import { type CtxOverrides, ctx, line, START } from "./helpers";

function sample(lines: EvalLine[], overrides: CtxOverrides, count = 600) {
	const context = ctx({
		...overrides,
		rng: createRng("rating-policy"),
		state: createSelectionState(),
	});
	const prior = heuristicPrior(context.fen, lines, context);
	let loss = 0;
	let blunders = 0;
	const moves = new Set<string>();
	for (let i = 0; i < count; i++) {
		const chosen = selectMove(lines, context, prior);
		loss += chosen.cpLoss ?? 0;
		blunders += Number(chosen.source === "blunder");
		moves.add(chosen.uci);
	}
	return { loss: loss / count, blunders, moves };
}

describe("rating-sensitive safeguards", () => {
	it("keeps Elo sensitivity and several safe continuations when converting a win", () => {
		const fen = "8/8/4k3/8/8/8/4P3/R3K3 w - - 0 40";
		const lines = [
			line(fen, "a1a8", { cp: 600 }, 1),
			line(fen, "e2e4", { cp: 580 }, 2),
			line(fen, "e1d2", { cp: 520 }, 3),
			line(fen, "e2e3", { cp: 350 }, 4),
		];
		const common = { fen, phase: "endgame" as const, ply: 78, blunderScale: 1 };
		const weak = sample(lines, { ...common, targetElo: 1000 });
		const club = sample(lines, { ...common, targetElo: 1650 });
		const strong = sample(lines, { ...common, targetElo: 2400 });
		expect(weak.moves.size).toBeGreaterThan(2);
		expect(club.moves.size).toBeGreaterThan(1);
		expect(weak.loss).toBeGreaterThan(club.loss);
		expect(club.loss).toBeGreaterThan(strong.loss);
		expect(strong.moves.has("e2e3")).toBe(false);
	});

	it("opponent time trouble modestly lowers accuracy without erasing the selected rating", () => {
		const lines = [
			line(START, "e2e4", { cp: 50 }, 1),
			line(START, "d2d4", { cp: 20 }, 2),
			line(START, "g1f3", { cp: -40 }, 3),
			line(START, "b1c3", { cp: -90 }, 4),
			line(START, "f2f3", { cp: -250 }, 5),
			line(START, "a2a3", { cp: -400 }, 6),
		];
		const clocks = { baseMs: 180000, incrementMs: 0, myClockMs: 90000, oppClockMs: 1000 };
		const ordinary = sample(lines, { ...clocks, targetElo: 1650, oppClockMs: 90000 }, 3000);
		const pressured = sample(lines, { ...clocks, targetElo: 1650 }, 3000);
		const strong = sample(lines, { ...clocks, targetElo: 2400 }, 3000);
		expect(pressured.loss).toBeGreaterThan(ordinary.loss);
		expect(pressured.loss).toBeLessThan(ordinary.loss * 1.5);
		expect(pressured.blunders).toBeGreaterThan(0);
		expect(strong.loss).toBeLessThan(pressured.loss);
	});

	it("does not label perception noise as a deliberate error in a near-equal candidate pool", () => {
		const lines = [line(START, "e2e4", { cp: 25 }, 1), line(START, "d2d4", { cp: 0 }, 2)];
		const result = sample(lines, { targetElo: 800, blunderScale: 100 });
		expect(result.blunders).toBe(0);
		expect(result.moves.size).toBe(2);
	});
});
