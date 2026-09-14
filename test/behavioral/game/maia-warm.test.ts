// test/behavioral/game/maia-warm.test.ts — 2026-09-11: the session asks for the Maia-3 size its
// target Elo maps to (`warmPolicy`) at game start, and never when the human model is off or the
// target is at or above `MAIA.eloMax`. 2026-09-13: one shipped size (79M), so `MAIA.sizeBands`
// has one band and a target moving anywhere under the ceiling — a settings write, the opponent's
// rating arriving — asks for nothing new: the warm is deduped on the size, and the size never
// changes. The earlier band-crossing re-warms (5M → 23M → 79M) went with the dropped sizes.
import { afterEach, expect, it } from "bun:test";
import { MAIA, MAIA_SIZES } from "@core/constants/maia";
import { maiaSizeFor } from "@core/policy/maia-size";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

it("warms the only size at game start, once, and a settings write under the ceiling asks for nothing new", async () => {
	const warmed: number[] = [];
	h = await createGameHarness({
		settings: { strength: { targetElo: 1200, matchOpponentRating: false } },
		warmPolicy: (targetElo) => warmed.push(targetElo),
	});
	expect(await h.until(() => warmed.length === 1, 1_000)).toBe(true);
	expect(warmed.map(maiaSizeFor)).toEqual(["79m"]);
	expect(MAIA_SIZES).toEqual(["79m"]);

	// Anywhere under `MAIA.eloMax`: the same size is already resident, nothing is asked for —
	// including the targets that used to sit in other bands (1800, 2300).
	for (const targetElo of [1300, 1800, 2300]) {
		await h.patch({ strength: { targetElo } });
		await h.advance(10);
		expect(warmed).toEqual([1200]);
	}

	// At or above MAIA.eloMax Stockfish selects: no warm.
	await h.patch({ strength: { targetElo: MAIA.eloMax } });
	await h.advance(10);
	expect(warmed).toEqual([1200]);

	// Back under the ceiling: the size is still the one remembered as warmed, so nothing new —
	// the resident 79M session was never evicted (the H15 prior above the ceiling uses it too).
	await h.patch({ strength: { targetElo: 1000 } });
	await h.advance(10);
	expect(warmed).toEqual([1200]);
});

it("the opponent's rating arriving moves an opponent-matched target but not the size: no re-warm", async () => {
	const warmed: number[] = [];
	h = await createGameHarness({
		settings: {
			strength: { targetElo: 1200, matchOpponentRating: true, personaEloOffset: 0 },
		},
		warmPolicy: (targetElo) => warmed.push(targetElo),
	});
	expect(await h.until(() => warmed.length === 1, 1_000)).toBe(true);
	expect(warmed).toEqual([1200]);
	await h.drive(() => h.site.opponent({ isBot: false, name: "them", ratingEstimate: 2100 }));
	await h.advance(10);
	expect(maiaSizeFor(2100)).toBe(maiaSizeFor(1200));
	expect(warmed).toEqual([1200]);
	// A re-estimate asks for nothing either.
	await h.drive(() => h.site.opponent({ isBot: false, name: "them", ratingEstimate: 2150 }));
	await h.advance(10);
	expect(warmed).toHaveLength(1);
});

it("never warms when the target starts at or above MAIA.eloMax", async () => {
	const high: number[] = [];
	h = await createGameHarness({
		settings: { strength: { targetElo: 2800, matchOpponentRating: false } },
		warmPolicy: (targetElo) => high.push(targetElo),
	});
	await h.arrive();
	await h.advance(500);
	expect(high).toEqual([]);
});
