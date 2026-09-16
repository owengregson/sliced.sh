import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { LIMITS } from "@core/constants/limits";
import { MAIA } from "@core/constants/maia";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import { maiaSearchMode, ownMoveBudget, searchBudget } from "@service/game-session/recommendation";
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

	// Owner, 2026-09-15: one division at the Maia cutoff. These cases pinned `maiaPriorMode` over
	// (3000, 3200] and its 12-root referee (`SEARCH_BUDGET.priorCandidates`); both are removed, so
	// they now pin that above the cutoff the referee is the plain native search.
	it("above the Maia cutoff there is no Maia mode and the referee is the plain native shape", () => {
		const base = { policy: true, clockRace: false };
		expect(maiaSearchMode({ ...base, targetElo: MAIA.eloMax })).toBe(true);
		for (const targetElo of [MAIA.eloMax + 1, 3100, 3200, 3201, LIMITS.eloMax])
			expect(maiaSearchMode({ ...base, targetElo })).toBe(false);
		for (const selectionMode of ["hybrid", "engine-elo"] as const) {
			const s = settings(selectionMode);
			expect(searchBudget({ ...comfortable, targetElo: 3100 }, s).multiPv).toBe(6);
			const own = ownMoveBudget({ ...ownPosition, targetElo: 3100 }, s);
			expect(own.multiPv).toBe(6);
			expect(own.depthCap).toBe(LIMITS.depthMax);
			expect(own.featureDepth).toBeUndefined();
		}
		// A configured MultiPV still widens it.
		expect(searchBudget({ ...comfortable, targetElo: 3100 }, settings("hybrid", 20)).multiPv).toBe(
			20
		);
	});
});
