// test/core/engine/uci-client/commands.test.ts
import { describe, expect, it } from "bun:test";
import { TIMINGS } from "@core/constants/timings";
import { goArgs, positionCommand, searchBudget } from "@core/engine/uci-client/commands";

describe("uci-client commands", () => {
	it("spells position with and without moves", () => {
		expect(positionCommand("8/8/8/8/8/8/8/K6k w - - 0 1", undefined)).toBe(
			"position fen 8/8/8/8/8/8/8/K6k w - - 0 1"
		);
		expect(positionCommand("F", [])).toBe("position fen F");
		expect(positionCommand("F", ["e2e4", "e7e5"])).toBe("position fen F moves e2e4 e7e5");
	});

	it("builds go arguments, defaulting an empty finite limit to the default movetime", () => {
		expect(goArgs({ infinite: true }, undefined)).toBe("infinite");
		expect(goArgs({}, undefined)).toBe(`movetime ${TIMINGS.analysisDefaultMovetimeMs}`);
		expect(goArgs({ depth: 12, movetimeMs: 500, nodes: 1000 }, ["e2e4", "d2d4"])).toBe(
			"depth 12 movetime 500 nodes 1000 searchmoves e2e4 d2d4"
		);
	});

	it("budgets movetime searches and ponders only", () => {
		expect(searchBudget({ movetimeMs: 300 }, "move", 50)).toBe(350);
		expect(searchBudget({ infinite: true }, "ponder", 50)).toBe(TIMINGS.ponderMaxMs);
		expect(searchBudget({ infinite: true }, "panel", 50)).toBeUndefined();
		expect(searchBudget({ depth: 10 }, "move", 50)).toBeUndefined();
	});
});
