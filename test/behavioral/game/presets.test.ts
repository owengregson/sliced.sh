// test/behavioral/game/presets.test.ts — Task 30 checklist item 8 end to end: the detected time
// control's preset reaches the timing model, and `manual` shows the plan without ever playing it
// (§8.5: "Auto-move disarmed → `planMove` is still computed and shown in the panel").
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
let other: GameHarness | undefined;
afterEach(async () => {
	await other?.dispose();
	other = undefined;
	await h?.dispose();
});

const BULLET = { baseMs: 60_000, incMs: 0 };

const presses = (harness: GameHarness): unknown[] =>
	harness.sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mousePressed"
	);

/** The think time the first plan of a seeded game asks for. */
async function firstThinkMs(harness: GameHarness): Promise<number> {
	await harness.arrive();
	expect(await harness.until(() => harness.session().recommendation() !== null, 10_000)).toBe(true);
	return harness.session().recommendation()?.plan.thinkMs ?? 0;
}

describe("game session: timing presets (§4.6, checklist 8)", () => {
	it("a bullet time control applies the `fast` preset — the same seeded position plans a shorter think than with no preset", async () => {
		// `natural` is a *preset*, so the detected class (bullet → fast, ×0.75) overrides it.
		h = await createGameHarness({
			timeControl: BULLET,
			gameId: "preset-game",
			settings: { timing: { profile: "natural", speedScale: 1 } },
		});
		const withPreset = await firstThinkMs(h);

		// `custom` is the user's own choice and is never overridden: the sliders stand.
		other = await createGameHarness({
			timeControl: BULLET,
			gameId: "preset-game",
			settings: { timing: { profile: "custom", speedScale: 1 } },
		});
		const noPreset = await firstThinkMs(other);

		expect(withPreset).toBeGreaterThan(0);
		expect(noPreset).toBeGreaterThan(0);
		expect(withPreset).toBeLessThan(noPreset);
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
