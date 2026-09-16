// test/behavioral/game/presets.test.ts — the timing knobs end to end, through a real session.
//
// 2026-09-15: the timing presets were removed at the owner's request ("remove the timing presets
// 'fast natural slow' etc."). The two tests this file used to hold — "a bullet time control
// applies the `fast` preset" and "`manual` computes and shows the plan but never plays it" —
// pinned that feature and were rewritten, not weakened, around what still decides the same two
// things: the detected time control's per-class gain (`SETTING_GAIN.moveTimeScale`) for pace, and
// `automation.autoMove` as the stored switch that decides whether a computed plan is ever played
// (§8.5: "Auto-move disarmed → `planMove` is still computed and shown in the panel").
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { SETTING_GAIN } from "@core/constants/setting-gain";
import type { DistributionHead, TimingPlan } from "@core/timing/types";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
let other: GameHarness | undefined;
afterEach(async () => {
	await other?.dispose();
	other = undefined;
	await h?.dispose();
});

const BULLET = { baseMs: 60_000, incMs: 0 };
const RAPID = { baseMs: 600_000, incMs: 0 };
// Exercise the discretionary think, above the physical gesture floor and below the budget cap. A
// seeded V1 opening draw can fall below the floor, correctly producing equal durations even though
// the gain reached the timing model.
const NORMAL_HEAD: DistributionHead = {
	id: "v1-parametric",
	sample: () => ({ tSec: 2, mode: "normal", why: ["gain fixture: normal body"] }),
	median: () => 2,
};

const presses = (harness: GameHarness): unknown[] =>
	harness.sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mousePressed"
	);

/** The first plan of a seeded game, including evidence that no floor/cap hid the gain. */
async function firstPlan(harness: GameHarness): Promise<TimingPlan> {
	await harness.arrive();
	expect(await harness.until(() => harness.session().recommendation() !== null, 10_000)).toBe(true);
	return harness.session().recommendation()!.plan;
}

describe("game session: the detected time control's timing gain", () => {
	it("reaches the timing model — the same seeded position plans a longer think in rapid than in bullet", async () => {
		// `SETTING_GAIN.moveTimeScale` is 1 for bullet and 1.3 for rapid, and `timingSettingsFor` is
		// the only place it is applied. The exact ratio is not asserted: unlike the old same-time-
		// control preset comparison, the clock terms (compression, caps, pressure) differ by class
		// too, so only the direction is a property of the gain alone.
		expect(SETTING_GAIN.moveTimeScale.bullet).toBeLessThan(SETTING_GAIN.moveTimeScale.rapid);
		h = await createGameHarness({
			timeControl: BULLET,
			gameId: "gain-game",
			head: NORMAL_HEAD,
			settings: { timing: { baseSpeed: 1 } },
		});
		const bullet = await firstPlan(h);

		other = await createGameHarness({
			timeControl: RAPID,
			gameId: "gain-game",
			head: NORMAL_HEAD,
			settings: { timing: { baseSpeed: 1 } },
		});
		const rapid = await firstPlan(other);

		for (const plan of [bullet, rapid]) {
			expect(plan.mode).toBe("normal");
			expect(plan.thinkMs).toBeGreaterThan(0);
			expect(plan.window.decisionMs).toBeGreaterThan(0);
			expect(plan.thinkMs).toBeLessThan(plan.features.capSec! * 1000);
		}
		expect(bullet.thinkMs).toBeLessThan(rapid.thinkMs);
	});

	it("auto-move off computes and shows the plan but never plays it", async () => {
		// What a user who had the `manual` preset now gets: their stored `automation.autoMove`
		// decides. Off — the shipped default — is the old `manual` behaviour exactly.
		h = await createGameHarness({
			settings: { automation: { autoMove: false } },
		});
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		expect(h.executor()?.isArmed() ?? false).toBe(false);

		const rec = h.session().recommendation();
		expect(rec?.plan.thinkMs).toBeGreaterThan(0);
		expect((await h.snapshot()).recommendation?.chosen.uci).toBe(rec?.chosen.uci);

		// The plan is on display, and nothing is ever dispatched.
		await h.advance((rec?.plan.thinkMs ?? 0) + 60_000);
		expect(presses(h)).toHaveLength(0);
		expect(h.site.board.lastMove()).toBeNull();
		expect(h.session().currentState()).toBe("live:my-turn:recommended");
	});
});
