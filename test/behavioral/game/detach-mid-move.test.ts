// test/behavioral/game/detach-mid-move.test.ts — §13: the hand never leaves a button held, and
// `chrome.debugger` is the only way it can let go. Taking the attachment away while the hand is
// mid-drag therefore has to wait for the release, which is what `MoveExecutor.whenIdle()` is for:
// `disarm()`'s abort needs several microtask hops to reach the hand's `recover()`, and a detach
// that overtakes it leaves the page with a pressed left button and a piece stuck to the cursor.
//
// The session's own path (`Settings.enabled` turned off mid-drag) is covered by
// `assistant-enabled.test.ts`; this file covers the other caller, `PANEL_DETACH_DEBUGGER` — the
// user pressing "detach" in the panel while a move is running.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { MSG } from "@core/constants/messages";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const mouseEvents = (type: string): unknown[] =>
	h.sim.debugger.commands.filter(
		(c) => c.method === CDP.inputDispatchMouseEvent && (c.params as { type: string }).type === type
	);

describe("the debugger is never taken away mid-drag (§13)", () => {
	it("PANEL_DETACH_DEBUGGER while the hand holds a piece releases it first", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: true }, execution: { style: "drag" } },
		});
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		// Inside the drag, with the button down: the press is held for the drag's whole body.
		expect(await h.until(() => mouseEvents("mousePressed").length > 0, 60_000)).toBe(true);
		expect(h.sim.input.pointer(h.tabId)?.buttons).toBe(1);
		expect(mouseEvents("mouseReleased")).toHaveLength(0);
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(true);

		// Dispatched, then the clock is advanced: the handler awaits the hand's wind-down, which is
		// what the detach must not overtake, and that wind-down needs the executor's own timers.
		let dispatched: Promise<unknown> | undefined;
		await h.sw.run(() => {
			dispatched =
				h.router._dispatch({ type: MSG.PANEL_DETACH_DEBUGGER, tabId: h.tabId }, {} as never) ??
				Promise.resolve({ success: false, error: "nothing handled the command" });
		});
		await h.advance(5_000);
		expect(await h.sw.run(() => dispatched)).toMatchObject({ success: true });

		// The page saw the pointer go back up, and only then did the attachment go away.
		expect(h.sim.input.pointer(h.tabId)?.buttons).toBe(0);
		expect(mouseEvents("mouseReleased")).toHaveLength(mouseEvents("mousePressed").length);
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(false);
		expect(h.executor()?.isArmed() ?? false).toBe(false);
		// Nothing was dispatched after the release, and no fresh attach followed (§13.4).
		const last = h.sim.debugger.commands.at(-1);
		expect((last?.params as { type?: string } | undefined)?.type).toBe("mouseReleased");
		expect(h.sim.debugger.attachments.filter((a) => a.action === "attach")).toHaveLength(1);
	});
});
