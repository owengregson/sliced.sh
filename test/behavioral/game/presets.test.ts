// test/behavioral/game/presets.test.ts — Task 30 checklist item 8 end to end: the detected time
// control's preset reaches the timing model, and `manual` shows the plan without ever playing it
// (§8.5: "Auto-move disarmed → `planMove` is still computed and shown in the panel").
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { TIMING_PROFILE_KNOBS } from "@core/constants/timings";
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
// Exercise the preset's discretionary think, above the physical gesture floor and below
// the bullet budget cap. A seeded V1 opening draw can fall below the floor in both profiles,
// correctly producing equal durations even though the preset reached the timing model.
const NORMAL_HEAD: DistributionHead = {
	id: "v1-parametric",
	sample: () => ({ tSec: 2, mode: "normal", why: ["preset fixture: normal body"] }),
	median: () => 2,
};

const presses = (harness: GameHarness): unknown[] =>
	harness.sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mousePressed"
	);

/** The first plan of a seeded game, including evidence that no floor/cap hid the preset. */
async function firstPlan(harness: GameHarness): Promise<TimingPlan> {
	await harness.arrive();
	expect(await harness.until(() => harness.session().recommendation() !== null, 10_000)).toBe(true);
	return harness.session().recommendation()!.plan;
}

describe("game session: timing presets (§4.6, checklist 8)", () => {
	it("a bullet time control applies the `fast` preset — the same seeded position plans a shorter think than with no preset", async () => {
		// `natural` is a *preset*, so the detected class (bullet → fast, ×0.75) overrides it.
		h = await createGameHarness({
			timeControl: BULLET,
			gameId: "preset-game",
			head: NORMAL_HEAD,
			settings: { timing: { profile: "natural", speedScale: 1 } },
		});
		const withPreset = await firstPlan(h);

		// `custom` is the user's own choice and is never overridden: the sliders stand.
		other = await createGameHarness({
			timeControl: BULLET,
			gameId: "preset-game",
			head: NORMAL_HEAD,
			settings: { timing: { profile: "custom", speedScale: 1 } },
		});
		const noPreset = await firstPlan(other);

		for (const plan of [withPreset, noPreset]) {
			expect(plan.mode).toBe("normal");
			expect(plan.thinkMs).toBeGreaterThan(0);
			expect(plan.window.decisionMs).toBeGreaterThan(0);
			expect(plan.thinkMs).toBeLessThan(plan.features.capSec! * 1000);
		}
		expect(withPreset.thinkMs).toBeLessThan(noPreset.thinkMs);
		expect(withPreset.thinkMs / noPreset.thinkMs).toBeCloseTo(TIMING_PROFILE_KNOBS.fast.speedScale);
	});

	it("`manual` computes and shows the plan but never plays it", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: true }, timing: { profile: "manual" } },
		});
		expect(await h.until(() => h.executor()?.isArmed() === true, 2_000)).toBe(true);
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);

		const rec = h.session().recommendation();
		expect(rec?.plan.thinkMs).toBeGreaterThan(0);
		expect((await h.snapshot()).recommendation?.chosen.uci).toBe(rec?.chosen.uci);

		// The hand is armed and the plan is on display, and still nothing is ever dispatched.
		await h.advance((rec?.plan.thinkMs ?? 0) + 60_000);
		expect(presses(h)).toHaveLength(0);
		expect(h.site.board.lastMove()).toBeNull();
		expect(h.session().currentState()).toBe("live:my-turn:recommended");
	});
});
