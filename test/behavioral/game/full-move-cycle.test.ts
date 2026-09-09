// test/behavioral/game/full-move-cycle.test.ts — Task 30 Step 2 (0) + (a): the whole per-tab
// cycle on the simulator, and the §13 focus/hand rules that hold across it.
//
//   content `hello` + `gameStarted` + `position` (my turn)
//     → engine request (the scripted offscreen answers with UCI lines)
//     → recommendation → panel snapshot → auto-move armed → scheduled
//     → the executor runs at `deadlineMs` → the move lands → `opponent-turn` → ponder started
import { afterEach, describe, expect, it } from "bun:test";
import { KEEPALIVE_REASONS } from "@core/constants/alarms";
import { CDP } from "@core/constants/cdp";
import { MSG } from "@core/constants/messages";
import { SEARCH_BUDGET } from "@core/constants/search";
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

describe("game session: the full move cycle (Step 2a)", () => {
	it("hello → gameStarted → my-turn position → engine → recommendation → armed → executed → opponent-turn → ponder", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		const session = h.session();
		expect(session.currentState()).toBe("live:opponent-turn");

		// (0) Arming attaches the debugger while the session is still waiting for a position.
		await h.sw.run(() => session.command("armAutoMove"));
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(true);
		expect(h.executor()?.isArmed()).toBe(true);

		// The first position of the game: our turn.
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		// A plan whose deadline is `now + thinkMs` is handed straight to the hand, which owns the
		// whole window (§8.4b item 3) — so the session is already `executing` by the time the
		// recommendation is observable, and the panel's countdown reads the running plan.
		expect(["live:my-turn:recommended", "live:my-turn:executing"]).toContain(session.currentState());

		// The engine was asked for this position with the §7.5 budget shape.
		const go = h.transport.goLines.at(-1) ?? "";
		expect(go).toMatch(/^go depth \d+ movetime \d+$/);
		expect(h.transport.positions.at(-1)).toContain("position fen ");

		const rec = session.recommendation();
		expect(rec).not.toBeNull();
		expect(rec?.chosen.uci.length).toBeGreaterThanOrEqual(4);
		expect(rec?.lines.length).toBeGreaterThan(1);
		expect(rec?.plan.thinkMs).toBeGreaterThan(0);

		// The panel snapshot carries the recommendation and the scheduled move.
		const snapshot = await h.snapshot();
		expect(snapshot.session.state).toBe("live:my-turn:executing");
		expect(snapshot.recommendation?.chosen.uci).toBe(rec?.chosen.uci);
		expect(snapshot.autoMove.armed).toBe(true);
		expect(snapshot.autoMove.scheduledAt).toBe(rec?.plan.deadlineMs);
		expect(snapshot.focus.handsOff).toBe(true);
		expect(snapshot.focus.pageHasFocus).toBe(true);

		// The hand runs and the move lands on the board.
		const before = presses().length;
		// The result is in once the verified execution has been reported (the drop is followed by
		// the post-drop rest and the adapter's `observeMove` acknowledgement).
		expect(await h.until(() => session.currentState() === "live:opponent-turn", 60_000)).toBe(true);
		expect(presses().length).toBeGreaterThan(before);
		const played = h.site.board.lastMove();
		expect(played?.byMe).toBe(true);
		expect(played?.uci).toBe(rec?.chosen.uci ?? "");

		// The realised hold never precedes the plan's deadline (§9.6a).
		const done = (await h.snapshot()).session.lastExecution;
		expect(done?.outcome).toBe("executed");
		expect(done?.san).toBe(rec?.chosen.san);
		expect(typeof done?.at).toBe("number");
		expect(h.sim.now()).toBeGreaterThanOrEqual((rec?.plan.deadlineMs ?? 0) - 1);

		// The position after our move is the opponent's turn, which opens the ponder:
		// `go infinite` with MultiPV 3 on their position (§6.4, Appendix E §4.2).
		await h.arrive();
		expect(await h.until(() => h.transport.goLines.some((l) => l === "go infinite"), 5_000)).toBe(
			true
		);
		expect(h.session().currentState()).toBe("live:opponent-turn");
		const multiPvSets = h.transport.sent.filter((l) => l.startsWith("setoption name MultiPV"));
		expect(multiPvSets.at(-1)).toBe(`setoption name MultiPV value ${SEARCH_BUDGET.ponderMultiPv}`);
	});

	it("holds Keepalive('game') while live and releases it when the session closes", async () => {
		h = await createGameHarness();
		await h.arrive();
		expect(await h.until(() => h.keepalive.reasons().includes(KEEPALIVE_REASONS.game), 5_000)).toBe(
			true
		);
		await h.sw.run(() => h.registry.dispose());
		await h.sim.time.runMicrotasks();
		expect(h.keepalive.reasons()).not.toContain(KEEPALIVE_REASONS.game);
	});

	it("never touches a focus-moving API during a live game (§13.4)", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		let tabsUpdate = 0;
		let tabsCreate = 0;
		let windowsUpdate = 0;
		const chrome = h.sim.chrome as unknown as Record<string, Record<string, unknown> | undefined>;
		const tabs = chrome.tabs as Record<string, unknown>;
		const windows = chrome.windows as Record<string, unknown>;
		tabs.update = () => {
			tabsUpdate += 1;
		};
		tabs.create = () => {
			tabsCreate += 1;
		};
		windows.update = () => {
			windowsUpdate += 1;
		};
		// The extension has no `chrome.notifications` surface at all (§13.4).
		expect(chrome.notifications).toBeUndefined();

		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);

		expect(tabsUpdate).toBe(0);
		expect(tabsCreate).toBe(0);
		expect(windowsUpdate).toBe(0);
		expect(h.sim.debugger.commandsFor("Page.bringToFront")).toHaveLength(0);
		// every dispatched input was CDP mouse input, nothing else
		const methods = new Set(h.sim.debugger.commands.map((c) => c.method));
		expect([...methods]).toEqual([CDP.inputDispatchMouseEvent]);
	});

	it("a blur during my-turn:recommended cancels the scheduled execution and the snapshot shows it", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => h.executor()?.runningMove() !== null, 5_000)).toBe(true);
		// The hand is inside the move window, still exploring: nothing committed yet.
		expect(presses()).toHaveLength(0);
		const deadline = h.session().recommendation()?.plan.deadlineMs ?? 0;

		await h.drive(() => h.site.panelClick()); // the side panel takes focus: the page blurs (§13.4)
		await h.advance(50);

		const snapshot = await h.snapshot();
		expect(snapshot.focus.blurSeenThisMove).toBe(true);
		expect(snapshot.focus.pageHasFocus).toBe(false);
		expect(h.executor()?.pendingMove()).toBeNull();
		// The hand has stopped, so the session must not sit in `executing` with nothing running —
		// the recommendation for this position still stands and the panel must show that.
		expect(await h.until(() => h.executor()?.runningMove() === null, 2_000)).toBe(true);
		expect(h.session().currentState()).toBe("live:my-turn:recommended");
		expect((await h.snapshot()).session.hand).toBe("resting");

		// The move is not played for this position — the extension waits instead of taking focus.
		await h.advance(Math.max(0, deadline - h.sim.now()) + 20_000);
		expect(h.site.board.lastMove()).toBeNull();
		expect((await h.snapshot()).autoMove.scheduledAt).toBeUndefined();
	});

	it("a real pointer event while the hand is active changes nothing but the counter (§13.5)", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => h.executor()?.runningMove() !== null, 5_000)).toBe(true);
		const rec = h.session().recommendation();

		await h.drive(() => {
			h.site.realPointer("pointermove", 40, 40);
			h.site.realPointer("pointermove", 60, 55);
		});
		await h.advance(300);
		expect((await h.snapshot()).focus.realPointerEventsDuringHand).toBeGreaterThan(0);

		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.uci).toBe(rec?.chosen.uci ?? "");
		expect((await h.snapshot()).session.lastExecution?.outcome).toBe("executed");
	});

	it("arming in `waiting-for-game` attaches the debugger before any game starts (§13.4)", async () => {
		h = await createGameHarness({ manualStart: true });
		await h.drive(() => h.site.hello());
		const session = h.session();
		expect(session.currentState()).toBe("waiting-for-game");
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(false);

		await h.sw.run(() => session.command("armAutoMove"));
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(true);
		expect(h.executor()?.isArmed()).toBe(true);
		// The attach happened with no game and no position — outside every move window.
		expect(session.view().gameId).toBeNull();
		const attaches = h.sim.debugger.attachments.filter((a) => a.action === "attach");
		expect(attaches).toHaveLength(1);

		// The game then starts with the hand still armed and the debugger still attached.
		await h.drive(() => h.site.startGame());
		expect(h.session().currentState()).toBe("live:opponent-turn");
		expect(await h.until(() => h.executor()?.isArmed() === true, 2_000)).toBe(true);
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(true);
		await h.arrive();
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		// Still exactly one attach: nothing re-attached mid-game.
		expect(h.sim.debugger.attachments.filter((a) => a.action === "attach")).toHaveLength(1);
	});

	it("the content script's hello opens the session and the SW answers CONTENT_HELLO with the keybinds", async () => {
		h = await createGameHarness({ manualStart: true });
		const reply = await h.sw.run(() =>
			h.router._dispatch({ type: MSG.CONTENT_HELLO }, { tab: { id: h.tabId } } as never)
		);
		expect(reply).toMatchObject({ success: true });
		const envelope = reply as { success: true; response: { keybinds: unknown; enabled: boolean } };
		expect(envelope.response.keybinds).toEqual(h.settings().keybinds);
		expect(envelope.response.enabled).toBe(h.settings().enabled);
		expect(h.registry.sessionFor(h.tabId)).not.toBeNull();
	});
});
