// test/behavioral/game/keybinds.test.ts — Task 30 Step 2 (e): the in-page keybinds are the §13.4
// in-game control path (the page keeps focus; the panel is display-only while a game is live).
// A trusted `keydown` on the page → the content script's capture listener → `CONTENT_KEYBIND` →
// the tab's `GameSession`.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { DEFAULT_KEYBINDS } from "@core/constants/defaults";
import { TIMINGS } from "@core/constants/timings";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const press = (bind: { key: string; code: string; shiftKey: boolean }): Promise<void> =>
	h.pressKey({ key: bind.key, code: bind.code, shiftKey: bind.shiftKey });

const presses = (): unknown[] =>
	h.sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mousePressed"
	);

describe("game session: in-page keybinds (Step 2e)", () => {
	it("playMove plays the current recommendation now", async () => {
		h = await createGameHarness({
			sendKeybinds: true,
			settings: { automation: { autoMove: true } },
		});
		await h.arrive();
		expect(await h.until(() => h.executor()?.runningMove() !== null, 10_000)).toBe(true);
		const rec = h.session().recommendation();
		const deadline = rec?.plan.deadlineMs ?? 0;
		expect(presses()).toHaveLength(0);

		await press(DEFAULT_KEYBINDS.playMove);
		expect(h.site.keybindActions()).toContain("playMove");
		// The instant plan collapses the remaining think window: the move lands well before the
		// deadline the normal plan had set.
		expect(await h.until(() => presses().length > 0, 5_000)).toBe(true);
		expect(h.sim.now()).toBeLessThan(deadline);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 30_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.uci).toBe(rec?.chosen.uci ?? "");
	});

	it("disable stops the session: idle, highlights cleared, executor cancelled", async () => {
		h = await createGameHarness({
			sendKeybinds: true,
			settings: { automation: { autoMove: true, highlightMoves: true } },
		});
		await h.arrive();
		expect(await h.until(() => h.executor()?.runningMove() !== null, 10_000)).toBe(true);
		expect(h.commands().some((c) => c.kind === "highlight")).toBe(true);
		const before = presses().length;

		await press(DEFAULT_KEYBINDS.disable);
		expect(h.site.keybindActions()).toContain("disable");
		expect(await h.until(() => h.session().currentState() === "idle", 2_000)).toBe(true);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(h.session().recommendation()).toBeNull();
		expect(h.commands().at(-1)?.kind).toBe("clearHighlight");

		await h.advance(60_000);
		expect(presses().length).toBe(before);
		expect(h.site.board.lastMove()).toBeNull();
	});

	it("speakMove speaks the recommendation through chrome.tts", async () => {
		h = await createGameHarness({ sendKeybinds: true });
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const rec = h.session().recommendation();

		await press(DEFAULT_KEYBINDS.speakMove);
		expect(await h.until(() => h.spoken.length > 0, 2_000)).toBe(true);
		expect(h.sim.tts.calls).toHaveLength(1);
		const spoken = h.spoken[0] ?? "";
		expect(spoken).not.toBe("");
		// A piece move is spoken as words, a pawn move as its square.
		const san = rec?.chosen.san ?? "";
		if (/^[KQRBN]/.test(san))
			expect(spoken.split(" ")[0]).toMatch(/^(king|queen|rook|bishop|knight)$/);
		else expect(spoken).toBe(san);
	});

	it("toggleAutoMove arms and disarms the hand", async () => {
		h = await createGameHarness({ sendKeybinds: true });
		expect(h.executor()?.isArmed()).toBe(false);
		await press(DEFAULT_KEYBINDS.toggleAutoMove);
		expect(await h.until(() => h.executor()?.isArmed() === true, 2_000)).toBe(true);
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(true);
		// The in-page listener drops a repeat of the same action inside `keybindDebounceMs`.
		await h.advance(TIMINGS.keybindDebounceMs + 1);
		await press(DEFAULT_KEYBINDS.toggleAutoMove);
		expect(await h.until(() => h.executor()?.isArmed() === false, 2_000)).toBe(true);
		// Disarming gives the pointer back but leaves the attachment alone (§13.4).
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(true);
	});
});
