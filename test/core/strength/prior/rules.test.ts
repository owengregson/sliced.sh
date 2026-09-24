// test/core/strength/prior/rules.test.ts
import { describe, expect, it } from "bun:test";
import { heuristicPriorDetailed } from "@core/strength/prior";
import { PRIOR_RULES } from "@core/strength/prior/rules";
import { ctx, line } from "../helpers";

const RECAPTURE_FEN = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

describe("PRIOR_RULES", () => {
	it("names every rule once", () => {
		const names = PRIOR_RULES.map((r) => r.rule);
		expect(new Set(names).size).toBe(names.length);
	});

	it("lists a line's terms in table order", () => {
		const lines = [line(RECAPTURE_FEN, "e4d5", { cp: 40 }, 1, ["d8d5"])];
		const terms = heuristicPriorDetailed(RECAPTURE_FEN, lines, ctx({ fen: RECAPTURE_FEN }))
			.get("e4d5")
			?.terms.map((t) => t.rule);
		const order = PRIOR_RULES.map((r) => r.rule);
		const indices = (terms ?? []).filter((t) => order.includes(t)).map((t) => order.indexOf(t));
		expect(indices).toEqual([...indices].sort((a, b) => a - b));
	});
});
