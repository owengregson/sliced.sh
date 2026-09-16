// test/core/strength/max-strength.test.ts — max-strength mode's predicate and registry (owner,
// 2026-09-15: "when elo rating bar is 3800 … just play the absolute best possible move").
import { describe, expect, it } from "bun:test";
import { EXECUTOR } from "@core/constants/cdp";
import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { MAX_STRENGTH } from "@core/constants/max-strength";
import { SEARCH_BUDGET } from "@core/constants/search";
import { isMaxStrength } from "@core/strength/max-strength";

describe("isMaxStrength", () => {
	it("is on exactly at the top of the product scale and nowhere below it", () => {
		expect(LIMITS.eloMax).toBe(3800);
		expect(isMaxStrength(LIMITS.eloMax)).toBe(true);
		expect(isMaxStrength(LIMITS.eloMax - 1)).toBe(false);
		// The full network starts above the Maia cutoff (2026-09-15; `LIMITS.nnueSmallEloMax` is gone).
		expect(isMaxStrength(MAIA.eloMax + 1)).toBe(false);
		expect(isMaxStrength(LIMITS.engineEloMax)).toBe(false);
		expect(isMaxStrength(LIMITS.eloMin)).toBe(false);
	});

	it("counts a target past the ceiling as max and a non-finite target as not", () => {
		expect(isMaxStrength(LIMITS.eloMax + 1)).toBe(true);
		expect(isMaxStrength(Number.NaN)).toBe(false);
		expect(isMaxStrength(Number.POSITIVE_INFINITY)).toBe(false);
	});
});

describe("MAX_STRENGTH registry", () => {
	it("reserves at least the stop receipt and the executor's minimum execution for the hand", () => {
		expect(MAX_STRENGTH.handReserveMs).toBeGreaterThanOrEqual(
			EXECUTOR.minExecutionMs + SEARCH_BUDGET.stopReceiptMs
		);
	});

	it("searches one line with no ceiling of its own, never shorter than a move search", () => {
		expect(MAX_STRENGTH.multiPv).toBe(LIMITS.multiPvMin);
		expect(MAX_STRENGTH.searchDepth).toBeGreaterThan(LIMITS.depthMax);
		expect(MAX_STRENGTH.minSearchMs).toBeGreaterThanOrEqual(SEARCH_BUDGET.minMovetimeMs);
		expect(MAX_STRENGTH.clockFraction).toBeGreaterThan(SEARCH_BUDGET.clockFraction);
		expect(MAX_STRENGTH.clockFraction).toBeLessThan(1);
	});

	it("takes the largest hash the registry allows, and no more", () => {
		expect(MAX_STRENGTH.hashMb).toBe(LIMITS.hashMbMax);
	});
});
