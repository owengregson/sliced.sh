import { describe, expect, test } from "bun:test";
import type { AnalysisResult } from "@core/engine/types";
import { PreparationWindow } from "@service/game-session/recommendation/context";
import { markIncompleteSearch } from "@service/game-session/recommendation/select";
import type { ChosenMove } from "@typedefs/game";

const BUDGET = { movetimeMs: 400, depthCap: 20, multiPv: 4 };

function chosen(source: ChosenMove["source"]): ChosenMove {
	return {
		uci: "e2e4",
		san: "e4",
		from: "e2",
		to: "e4",
		source,
		rankInLines: 1,
		cpLoss: 12,
		quality: { kind: "search", eligible: true, depth: 14, candidates: 4 },
		rationale: [],
	} as ChosenMove;
}

function analysis(complete: boolean): AnalysisResult {
	return { final: { complete, depth: 9 } } as unknown as AnalysisResult;
}

describe("PreparationWindow", () => {
	test("cuts a request to the time left before the shared deadline", () => {
		let now = 1_000;
		const window = new PreparationWindow(1_000, BUDGET, () => now);
		expect(window.deadlineMs).toBe(1_400);
		expect(window.remaining({ ...BUDGET, movetimeMs: 250 })?.movetimeMs).toBe(250);
		now = 1_300.4;
		expect(window.remaining(BUDGET)?.movetimeMs).toBe(100);
		now = 1_399.9;
		expect(window.remaining(BUDGET)?.movetimeMs).toBe(1);
		now = 1_400;
		expect(window.remaining(BUDGET)).toBeNull();
	});
});

describe("markIncompleteSearch", () => {
	test("drops the loss sample of a move chosen from an incomplete search", () => {
		const move = chosen("sampled");
		markIncompleteSearch(move, analysis(false), 3);
		expect(move.cpLoss).toBeUndefined();
		expect(move.quality).toEqual({
			kind: "search",
			eligible: false,
			reason: "incomplete",
			depth: 9,
			candidates: 3,
		});
	});

	test("leaves book moves, complete searches and missing analysis alone", () => {
		for (const [move, result] of [
			[chosen("book"), analysis(false)],
			[chosen("sampled"), analysis(true)],
			[chosen("sampled"), null],
		] as const) {
			markIncompleteSearch(move, result, 3);
			expect(move.cpLoss).toBe(12);
		}
	});
});
