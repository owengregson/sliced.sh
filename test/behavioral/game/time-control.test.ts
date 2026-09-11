// test/behavioral/game/time-control.test.ts — §4.3 / §4.6 / §8.4b: the time control the *page*
// reports reaches the timing model, the motor and the §7.4 premove gate, including when it arrives
// after the game has started (the production order: `timeControl.get()` is null until the game
// actually starts, and the session is created from a snapshot taken before the MAIN-world bridge
// has answered anything, so `GameMeta.timeControl` is normally absent).
//
// Every assertion here is on what the site supplied. `site.setTimeControl(...)` is the page
// learning its own clock, not the harness telling the session what class to be.
import { afterEach, describe, expect, it } from "bun:test";
import { SEARCH_BUDGET } from "@core/constants/search";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const BULLET = { baseMs: 60_000, incMs: 0 };

/** The feature record the timing model attached to the standing plan. */
function features(harness: GameHarness): Record<string, number> {
	return harness.session().recommendation()?.plan.features ?? {};
}

async function recommended(harness: GameHarness): Promise<boolean> {
	return harness.until(() => harness.session().recommendation() !== null, 10_000);
}

describe("game session: the time control arrives after the game started (§4.3)", () => {
	it("plans the first position untimed, then re-profiles the model AND the hand when the site answers", async () => {
		h = await createGameHarness({
			timeControl: null, // the site has not answered yet — the production order
			gameId: "late-tc",
			settings: { automation: { autoMove: false }, timing: { profile: "natural" } },
		});
		// Move 1 with no clock: every clock-pressure term is bypassed and the hand is classical.
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		expect(await recommended(h)).toBe(true);
		expect(features(h).tc_untimed).toBe(1);
		expect(features(h).tc_bullet).toBe(0);
		// `untimedVirtual` substitutes a 300 s clock and throws the real reading away.
		expect(features(h).clock_s).toBe(TIMING_CONSTANTS.untimedVirtual.clockS);
		expect(features(h).pressure).toBe(1);
		expect(h.executor()?.timeControlClass()).toBe("classical");
		expect((await h.snapshot()).session.timeControl).toBeUndefined();

		// The game starts: the site now answers `{baseTime: 60000, increment: 0}`. The position has
		// not moved — as white it cannot — so this is the republished ply, and it must not be taken
		// for the reconnect replay.
		h.site.setTimeControl(BULLET);
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		expect(await h.until(() => features(h).tc_bullet === 1, 10_000)).toBe(true);

		// The model now conditions on the real clock …
		expect(features(h).tc_untimed).toBe(0);
		expect(features(h).clock_s).toBeCloseTo(BULLET.baseMs / 1000, 6);
		expect(features(h).base_s).toBe(BULLET.baseMs / 1000);
		// … and the hand is a bullet hand, which is what the final review found `reprofile` missed.
		expect(h.executor()?.timeControlClass()).toBe("bullet");
		// …and the panel sees it.
		expect((await h.snapshot()).session.timeControl).toEqual(BULLET);
	});

	it("re-profiles even when the clock arrives after our first move, keeping the game's history", async () => {
		h = await createGameHarness({
			timeControl: null,
			gameId: "late-tc-after-move",
			settings: { automation: { autoMove: true }, strength: { matchOpponentRating: false } },
		});
		expect(await h.until(() => h.executor()?.isArmed() === true, 2_000)).toBe(true);
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		expect(await recommended(h)).toBe(true);
		const firstPlan = h.session().recommendation()?.plan.thinkMs ?? 0;
		expect(firstPlan).toBeGreaterThan(0);
		// let the hand play the move, so the model has observed a think time for this game
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);

		// The clock arrives on an opponent-turn position, a move late. The old guard
		// (`myThinkMs.length > 0`) refused here and the game stayed untimed for its whole length.
		h.site.setTimeControl(BULLET);
		await h.arrive();
		expect(h.executor()?.timeControlClass()).toBe("bullet");

		// Our turn again: the plan is now conditioned on the real clock …
		const reply = h.transport.movesFor(h.site.board.fen())[0] as string;
		await h.arrive(reply);
		expect(await h.until(() => features(h).tc_bullet === 1, 20_000)).toBe(true);
		expect(features(h).tc_untimed).toBe(0);
		// … and the rebuilt model kept this game's own history rather than starting a new game:
		// the move already played is still in the §8.6 log with its realised think time, and the
		// CV guard's population (`plannedMs`) still holds both plans.
		const played = h.timingLog.entries().filter((e) => e.actualMs !== null);
		expect(played.length).toBeGreaterThanOrEqual(1);
		expect(h.session().recommendation()?.plan.features.eps).toBeDefined();
	}, 120_000);

	it("re-profiles from a reading the own-hand guard drops, so the clock is not deferred a ply", async () => {
		// §4.3's republish is a **one-shot**: `AdapterBase.apply` records `lastTimeControl` before it
		// decides to publish, the adapter has no position poll, and `scheduleTimeControlProbe` stops
		// once a time control has been seen — so a reading that is dropped is never re-offered. The
		// re-ask runs on a 1 s timer and the hand's action takes seconds, so the republish lands
		// squarely inside the window `GameSession.ownHandsDoing` drops readings in. It is therefore
		// `salvageFromOwnHand` that has to take the clock out of the reading before the rest of it
		// goes; without that the whole of the next move is still planned untimed.
		h = await createGameHarness({
			timeControl: null,
			gameId: "late-tc-mid-move",
			settings: { automation: { autoMove: true, highlightMoves: true } },
		});
		expect(await h.until(() => h.executor()?.isArmed() === true, 2_000)).toBe(true);
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		expect(await recommended(h)).toBe(true);
		expect(h.executor()?.timeControlClass()).toBe("classical");
		expect(await h.until(() => h.executor()?.runningMove() !== null, 20_000)).toBe(true);
		const running = h.session().recommendation();
		const marksBefore = h.commands().filter((c) => c.kind === "clearHighlight").length;

		// The site answers its clock while the hand is mid-move, and the adapter republishes the
		// position that has not moved to deliver it: same ply, same side to move.
		h.site.setTimeControl(BULLET);
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });

		// The reading itself was dropped — the recommendation and the board are untouched …
		expect(h.session().recommendation()).toBe(running);
		expect(h.commands().filter((c) => c.kind === "clearHighlight").length).toBe(marksBefore);
		// … and the clock it carried was taken out of it first.
		expect(h.executor()?.timeControlClass()).toBe("bullet");
		expect((await h.snapshot()).session.timeControl).toEqual(BULLET);
	}, 60_000);

	it("the engine's own `go` line carries the class budget the clock selects", async () => {
		// §6.4 / §7.5 end to end through the real `EngineController` + `UciEngine`: the search the
		// engine is actually asked for follows the time control, not the planned wait. Before this
		// lane every game asked for `movetime 4000` — the cap — because the budget was
		// `0.6 × plannedThinkMs` and every game planned ≈ 7.5 s.
		const movetimeOf = (harness: GameHarness): string =>
			harness.transport.goLines.filter((l) => l.includes("movetime")).at(-1) ?? "";

		h = await createGameHarness({
			timeControl: null, // the page reports no clock: the clockless class
			gameId: "budget-untimed",
			settings: { automation: { autoMove: false } },
		});
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		expect(await recommended(h)).toBe(true);
		expect(features(h).tc_untimed).toBe(1);
		expect(movetimeOf(h)).toContain(`movetime ${SEARCH_BUDGET.moveMs.untimed}`);
		expect(movetimeOf(h)).not.toContain(`movetime ${SEARCH_BUDGET.maxMovetimeMs}`);

		await h.dispose();
		h = await createGameHarness({
			timeControl: BULLET, // the page reports a 1+0 bullet clock
			gameId: "budget-bullet",
			settings: { automation: { autoMove: false } },
		});
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		expect(await recommended(h)).toBe(true);
		expect(features(h).tc_bullet).toBe(1);
		expect(movetimeOf(h)).toContain(`movetime ${SEARCH_BUDGET.moveMs.bullet}`);
		expect(movetimeOf(h)).toContain(`depth ${SEARCH_BUDGET.depthCap.bullet}`);
	}, 60_000);

	it("the page's own clock is what opens the §7.4 premove gate (bullet/blitz only)", async () => {
		// `isPremoveSpeed(undefined)` is false, so with no time control on the snapshot §7.4 can
		// never fire — which is what production did on every game. The page answering its clock is
		// what opens the gate; nothing else about the game changes.
		const SEEDS = 6;

		/** Play move 1, hand the page's clock over (or not), let the opponent reply as predicted. */
		async function run(seed: number, withClock: boolean): Promise<string | undefined> {
			await h?.dispose();
			h = await createGameHarness({
				timeControl: null,
				gameId: `premove-gate-${seed}`,
				seed: `premove-gate-${seed}`,
				settings: {
					automation: { autoMove: true },
					strength: { matchOpponentRating: false, targetElo: 3000 },
				},
				script: { bestCp: 900, stepCp: 900 },
			});
			// move 1 (untimed either way: the site has not answered yet)
			await h.arrive();
			expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
				true
			);
			// the site learns its clock exactly here, before the opponent-turn position
			if (withClock) h.site.setTimeControl(BULLET);
			await h.arrive();
			await h.advance(2_000);
			const expected = h.transport.movesFor(h.site.board.fen())[0] as string;
			await h.arrive(expected);
			expect(await h.until(() => h.session().recommendation() !== null, 20_000)).toBe(true);
			return h.session().recommendation()?.chosen.source;
		}

		// With no clock the gate is unreachable, and that is asserted for EVERY seed — a loop that
		// stopped at the first firing would have proved it for one.
		for (let seed = 0; seed < SEEDS; seed++) expect(await run(seed, false)).not.toBe("premove");

		// With the page's clock the gate opens; §7.4's probability is a per-game draw, so this is
		// "at least one of the same seeds fires".
		let fired = false;
		for (let seed = 0; seed < SEEDS && !fired; seed++) fired = (await run(seed, true)) === "premove";
		expect(fired).toBe(true);
	}, 300_000);
});
