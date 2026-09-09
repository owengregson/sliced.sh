// test/behavioral/game/commands.test.ts — Task 30 Step 2 (f): a `chrome.commands` shortcut is
// browser-level, so the page never loses focus (§13.4) — it routes to the active tab's session.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { COMMAND_NAMES } from "@service/game-session";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const presses = (): unknown[] =>
	h.sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mousePressed"
	);

/** Fire the manifest shortcut the way Chrome does, with the worker's context active. */
const fire = (command: string): Promise<void> => h.drive(() => h.sim.commands.trigger(command));

describe("game session: chrome.commands shortcuts (Step 2f)", () => {
	it("play-best-move routes to the active tab's session and plays now", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await h.arrive();
		expect(await h.until(() => h.executor()?.runningMove() !== null, 10_000)).toBe(true);
		const rec = h.session().recommendation();
		const deadline = rec?.plan.deadlineMs ?? 0;
		expect(presses()).toHaveLength(0);
		const focusBefore = h.site.pageFocusEvents();

		await fire(COMMAND_NAMES.playBestMove);
		expect(await h.until(() => presses().length > 0, 5_000)).toBe(true);
		expect(h.sim.now()).toBeLessThan(deadline);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 30_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.uci).toBe(rec?.chosen.uci ?? "");
		// A browser-level shortcut never moves focus (§13.4).
		expect(h.site.pageFocusEvents()).toEqual(focusBefore);
		expect(h.sim.debugger.commandsFor("Page.bringToFront")).toHaveLength(0);
	});

	it("toggle-auto-move arms and disarms; disable-assistant stops the session", async () => {
		h = await createGameHarness();
		expect(h.executor()?.isArmed()).toBe(false);
		await fire(COMMAND_NAMES.toggleAutoMove);
		expect(await h.until(() => h.executor()?.isArmed() === true, 2_000)).toBe(true);
		await fire(COMMAND_NAMES.toggleAutoMove);
		expect(await h.until(() => h.executor()?.isArmed() === false, 2_000)).toBe(true);

		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		await fire(COMMAND_NAMES.disableAssistant);
		expect(await h.until(() => h.session().currentState() === "idle", 2_000)).toBe(true);
		expect(h.session().recommendation()).toBeNull();
	});

	it("an unknown command is a no-op", async () => {
		h = await createGameHarness();
		const state = h.session().currentState();
		await fire("not-a-command");
		await h.advance(50);
		expect(h.session().currentState()).toBe(state);
	});
});
