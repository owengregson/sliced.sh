// test/core/strength/selector/state.test.ts
import { describe, expect, it } from "bun:test";
import { SELECTION_CONSTANTS as C } from "@core/strength/constants";
import { advanceSelectionState, createSelectionState } from "@core/strength/selector/state";

describe("advanceSelectionState", () => {
	it("counts top-1 streaks and resets them on any other rank", () => {
		const state = createSelectionState();
		advanceSelectionState(state, { uci: "e2e4", rank: 1, cpRaw: 30 }, "sampled");
		advanceSelectionState(state, { uci: "g1f3", rank: 1, cpRaw: 25 }, "sampled");
		expect(state.top1Streak).toBe(2);
		advanceSelectionState(state, { uci: "f1c4", rank: 2, cpRaw: 10 }, "sampled");
		expect(state.top1Streak).toBe(0);
	});

	it("arms the blunder damper on an injected blunder and counts it down otherwise", () => {
		const state = createSelectionState();
		advanceSelectionState(state, { uci: "e2e4", rank: 3, cpRaw: -200 }, "blunder");
		expect(state.blunderDamperLeft).toBe(C.blunder.damperMoves);
		advanceSelectionState(state, { uci: "g1f3", rank: 1, cpRaw: 0 }, "maia");
		expect(state.blunderDamperLeft).toBe(C.blunder.damperMoves - 1);
	});

	it("keeps only the most recent own moves", () => {
		const state = createSelectionState();
		const moves = ["a2a3", "b2b3", "c2c3", "d2d3", "e2e3", "f2f3"];
		for (const uci of moves) advanceSelectionState(state, { uci, rank: 1, cpRaw: 0 }, "sampled");
		expect(state.previousOwnMoves).toEqual(moves.slice(-C.prior.previousOwnMovesKept));
	});

	it("remembers a scored pick's value, forgets an unscored one, and counts the tilt down", () => {
		const state = createSelectionState();
		state.tiltMovesLeft = 2;
		advanceSelectionState(state, { uci: "e2e4", rank: 1, cpRaw: 45 }, "maia");
		expect(state.lastPickCp).toBe(45);
		expect(state.tiltMovesLeft).toBe(1);
		advanceSelectionState(state, { uci: "g1f3", rank: 0, cpRaw: 0 }, "engine-elo");
		expect(state.lastPickCp).toBeUndefined();
		expect(state.tiltMovesLeft).toBe(0);
	});
});
