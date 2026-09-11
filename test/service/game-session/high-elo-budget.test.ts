import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { ownMoveBudget, searchBudget } from "@service/game-session/recommendation";
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
	it("switches Hybrid at 2500 without changing its time or depth budget", () => {
		const below = searchBudget({ ...comfortable, targetElo: 2499 }, settings("hybrid"));
		const at = searchBudget({ ...comfortable, targetElo: 2500 }, settings("hybrid"));
		expect(below).toEqual({ movetimeMs: 600, depthCap: 18, multiPv: 12 });
		expect(at).toEqual({ movetimeMs: 600, depthCap: 18, multiPv: 6 });
		expect(at).toEqual(searchBudget({ ...comfortable, targetElo: 2500 }, settings("engine-elo")));
	});

	it("gives 2600 and 2700 Hybrid the same allocation as native engine mode", () => {
		for (const targetElo of [2600, 2700]) {
			const input = { ...comfortable, targetElo };
			expect(searchBudget(input, settings("hybrid"))).toEqual({
				movetimeMs: 600,
				depthCap: 18,
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
			depthCap: 18,
			multiPv: 3,
		});
		expect(searchBudget(tiny, settings("hybrid", 8)).multiPv).toBe(8);
		expect(searchBudget({ ...tiny, legalMoves: 2 }, settings("hybrid", 8)).multiPv).toBe(2);
		expect(searchBudget({ ...tiny, legalMoves: 1 }, settings("hybrid", 8))).toEqual({
			movetimeMs: 150,
			depthCap: 18,
			multiPv: 1,
		});
	});

	it("uses the active target and effective form when sizing an own-move Hybrid search", () => {
		const s = settings("hybrid");
		const neutral = ownMoveBudget({ ...ownPosition, targetElo: 2600, form: 0 }, s);
		const poorForm = ownMoveBudget({ ...ownPosition, targetElo: 2600, form: -1 }, s);
		const goodForm = ownMoveBudget({ ...ownPosition, targetElo: 2499, form: 1 }, s);
		expect(neutral).toEqual({ movetimeMs: 600, depthCap: 18, multiPv: 6 });
		expect(poorForm).toEqual({ movetimeMs: 600, depthCap: 18, multiPv: 12 });
		expect(goodForm).toEqual(neutral);
		expect(ownMoveBudget({ ...ownPosition, targetElo: 2600 }, s)).toEqual(neutral);
		expect(s.strength.targetElo).toBe(1500);
	});

	it("keeps explicit Persona breadth tied to its active target when form crosses a band", () => {
		const s = settings("persona-sampling");
		expect(ownMoveBudget({ ...ownPosition, targetElo: 2600, form: 1 }, s).multiPv).toBe(12);
		expect(ownMoveBudget({ ...ownPosition, targetElo: 2700, form: -1 }, s).multiPv).toBe(6);
	});
});
