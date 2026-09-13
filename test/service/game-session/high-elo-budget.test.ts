import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { SEARCH_BUDGET } from "@core/constants/search";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import {
	maiaPriorMode,
	maiaSearchMode,
	ownMoveBudget,
	searchBudget,
} from "@service/game-session/recommendation";
import type { Settings } from "@typedefs/settings";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function settings(selectionMode: Settings["strength"]["selectionMode"], multiPv = 1): Settings {
	return {
		...DEFAULT_SETTINGS,
		strength: { ...DEFAULT_SETTINGS.strength, targetElo: 1500, selectionMode },
		engine: { ...DEFAULT_SETTINGS.engine, multiPv },
	};
}

const comfortable = {
	tc: "blitz" as const,
	myClockMs: 180_000,
	legalMoves: 20,
	plannedThinkMs: 4000,
};

const ownPosition = {
	fen: START,
	ply: 0,
	myClockMs: 180_000,
	oppClockMs: 180_000,
	timeControl: { baseMs: 180_000, incMs: 2000 },
	tau: 0.5,
	budgetUsedRatio: 0,
};

describe("high-Elo search candidate allocation", () => {
	it("switches Hybrid breadth at 2500 while time stays bounded and depth follows Elo", () => {
		const below = searchBudget({ ...comfortable, targetElo: 2499 }, settings("hybrid"));
		const at = searchBudget({ ...comfortable, targetElo: 2500 }, settings("hybrid"));
		expect(below).toEqual({ movetimeMs: 600, depthCap: automaticDepthForElo(2499), multiPv: 12 });
		expect(at).toEqual({ movetimeMs: 600, depthCap: automaticDepthForElo(2500), multiPv: 6 });
		expect(at).toEqual(searchBudget({ ...comfortable, targetElo: 2500 }, settings("engine-elo")));
	});

	it("gives 2600 and 2700 Hybrid the same allocation as native engine mode", () => {
		for (const targetElo of [2600, 2700]) {
			const input = { ...comfortable, targetElo };
			expect(searchBudget(input, settings("hybrid"))).toEqual({
				movetimeMs: 600,
				depthCap: automaticDepthForElo(targetElo),
				multiPv: 6,
			});
			expect(searchBudget(input, settings("hybrid"))).toEqual(
				searchBudget(input, settings("engine-elo"))
			);
		}
	});

	it("retains the explicit Persona candidate policy on either side of both boundaries", () => {
		for (const targetElo of [2499, 2500, 2600])
			expect(searchBudget({ ...comfortable, targetElo }, settings("persona-sampling")).multiPv).toBe(
				12
			);
		expect(
			searchBudget({ ...comfortable, targetElo: 2700 }, settings("persona-sampling")).multiPv
		).toBe(6);
	});

	it("honors configured MultiPV and legal-root limits in the native Hybrid branch", () => {
		const tiny = { ...comfortable, targetElo: 2700, plannedThinkMs: 400 };
		expect(searchBudget(tiny, settings("hybrid", 1))).toEqual({
			movetimeMs: 240,
			depthCap: automaticDepthForElo(2700),
			multiPv: 3,
		});
		expect(searchBudget(tiny, settings("hybrid", 8)).multiPv).toBe(8);
		expect(searchBudget({ ...tiny, legalMoves: 2 }, settings("hybrid", 8)).multiPv).toBe(2);
		expect(searchBudget({ ...tiny, legalMoves: 1 }, settings("hybrid", 8))).toEqual({
			movetimeMs: 150,
			depthCap: automaticDepthForElo(2700),
			multiPv: 1,
		});
	});

	it("uses the active target and effective form when sizing an own-move Hybrid search", () => {
		const s = settings("hybrid");
		const neutral = ownMoveBudget({ ...ownPosition, targetElo: 2600, form: 0 }, s);
		const poorForm = ownMoveBudget({ ...ownPosition, targetElo: 2600, form: -1 }, s);
		const goodForm = ownMoveBudget({ ...ownPosition, targetElo: 2499, form: 1 }, s);
		expect(neutral).toEqual({ movetimeMs: 600, depthCap: automaticDepthForElo(2600), multiPv: 6 });
		expect(poorForm).toEqual({ movetimeMs: 600, depthCap: automaticDepthForElo(2600), multiPv: 12 });
		expect(goodForm).toEqual({ ...neutral, depthCap: automaticDepthForElo(2499) });
		expect(ownMoveBudget({ ...ownPosition, targetElo: 2600 }, s)).toEqual(neutral);
		expect(s.strength.targetElo).toBe(1500);
	});

	it("keeps explicit Persona breadth tied to its active target when form crosses a band", () => {
		const s = settings("persona-sampling");
		expect(ownMoveBudget({ ...ownPosition, targetElo: 2600, form: 1 }, s).multiPv).toBe(12);
		expect(ownMoveBudget({ ...ownPosition, targetElo: 2700, form: -1 }, s).multiPv).toBe(6);
	});

	it("expands opponent-only rush candidates without increasing the search time or own-emergency breadth", () => {
		const input = {
			...ownPosition,
			targetElo: 2700,
			myClockMs: 90_000,
			oppClockMs: 1000,
			timeControl: { baseMs: 180_000, incMs: 0 },
		};
		const race = clockRacePolicy({
			ownClockMs: input.myClockMs,
			opponentClockMs: input.oppClockMs,
			baseMs: input.timeControl.baseMs,
			incrementMs: 0,
		});
		expect(ownMoveBudget(input, settings("hybrid"))).toEqual({
			depthCap: automaticDepthForElo(2700),
			movetimeMs: race!.maxSearchMs,
			multiPv: 12,
		});
		expect(ownMoveBudget(input, settings("hybrid", 20)).multiPv).toBe(20);
		// One legal check evasion, Kxa2: breadth cannot exceed available roots.
		expect(
			ownMoveBudget({ ...input, fen: "7k/8/8/8/8/8/r7/KR6 w - - 0 1" }, settings("hybrid", 20)).multiPv
		).toBe(1);
		expect(ownMoveBudget({ ...input, myClockMs: 1000 }, settings("hybrid")).multiPv).toBe(3);
	});

	// H15 (2026-09-13): above 2600 a Maia-79M prior breaks the engine's ties, which needs a pool.
	it("maiaPriorMode: from MAIA.eloMax up to LIMITS.eloMax, with a port and no race; never below", () => {
		const base = { policy: true, clockRace: false };
		expect(maiaPriorMode({ ...base, targetElo: MAIA.eloMax })).toBe(true);
		expect(maiaPriorMode({ ...base, targetElo: 3000 })).toBe(true);
		expect(maiaPriorMode({ ...base, targetElo: LIMITS.eloMax - 1 })).toBe(true);
		expect(maiaPriorMode({ ...base, targetElo: LIMITS.eloMax })).toBe(false);
		expect(maiaPriorMode({ ...base, targetElo: MAIA.eloMax - 1 })).toBe(false);
		expect(maiaPriorMode({ ...base, targetElo: 2700, policy: false })).toBe(false);
		expect(maiaPriorMode({ ...base, targetElo: 2700, clockRace: true })).toBe(false);
		// the two modes never overlap, and `maiaSearchMode` is exactly what it was below 2600
		for (const targetElo of [800, 2599, 2600, 2700, 3799])
			expect(maiaSearchMode({ ...base, targetElo }) && maiaPriorMode({ ...base, targetElo })).toBe(
				false
			);
		expect(maiaSearchMode({ ...base, targetElo: 2599 })).toBe(true);
	});

	it("the prior's referee keeps the native strength shape but asks for priorCandidates roots", () => {
		for (const selectionMode of ["hybrid", "engine-elo"] as const) {
			const s = settings(selectionMode);
			const plain = searchBudget({ ...comfortable, targetElo: 2700 }, s);
			const prior = searchBudget({ ...comfortable, targetElo: 2700, maiaPrior: true }, s);
			expect(plain.multiPv).toBe(6);
			expect(prior).toEqual({ ...plain, multiPv: SEARCH_BUDGET.priorCandidates });
			expect(ownMoveBudget({ ...ownPosition, targetElo: 2700, maiaPrior: true }, s).multiPv).toBe(
				SEARCH_BUDGET.priorCandidates
			);
		}
		// the prior never widens a search that is already broad, and never adds a human frame
		expect(
			searchBudget({ ...comfortable, targetElo: 2700, maiaPrior: true }, settings("hybrid", 20))
				.multiPv
		).toBe(20);
		expect(
			ownMoveBudget({ ...ownPosition, targetElo: 2700, maiaPrior: true }, settings("hybrid"))
				.featureDepth
		).toBeUndefined();
	});
});
