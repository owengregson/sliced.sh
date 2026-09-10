// test/behavioral/game/assistant-enabled.test.ts — §4.4: `Settings.enabled` is the master switch,
// and the panel's own copy for it is a promise ("Off stops analysis and recommendations until you
// turn it back on."). These tests hold the orchestrator to it on the simulator, from the side the
// user can see: what the engine is asked, what the board shows, what CDP dispatched, whether the
// hand is armed and whether the debugger is attached.
//
//   (a) off from the start: arming is refused, a position produces no search, no recommendation,
//       no highlight, no scheduled move, zero CDP input — and the auto-queue never asks the page
//       for a new game;
//   (b) off mid-think: the scheduled move is cancelled before it lands, the hand is disarmed, the
//       debugger released and the board cleared;
//   (c) back on mid-game: the session resumes from the live position without a reload, and with
//       the hand armed again the next position is recommended and played;
//   (d) off after the press is committed: the hand releases the button before the debugger goes,
//       and the move in flight may still land (the §13.4 blur-cancel contract) while nothing new
//       is ever searched, recommended or played.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP, PANEL_COMMAND_ERRORS } from "@core/constants/cdp";
import { MSG } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { setSettings } from "@core/storage/settings-storage";
import type { PositionSnapshot } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const [, MAX_QUEUE_DELAY] = TIMINGS.autoQueueDelayRangeMs;

/** The mouse events the hand dispatched over CDP, by `type`. */
const mouseEvents = (type: string): unknown[] =>
	h.sim.debugger.commands.filter(
		(c) => c.method === CDP.inputDispatchMouseEvent && (c.params as { type: string }).type === type
	);

/** Every `Input.dispatchMouseEvent` the hand committed a press with. */
const presses = (): unknown[] => mouseEvents("mousePressed");

const commandKinds = (kind: string): unknown[] => h.commands().filter((c) => c.kind === kind);

/** The `highlightMoves` gate the worker last pushed to the content script (§13.3 rule 4). */
const lastHighlightGate = (): boolean | undefined => {
	const settings = h.commands().filter((c) => c.kind === "settings");
	const last = settings.at(-1);
	return last && last.kind === "settings" ? last.highlightMoves : undefined;
};

describe("game session: the assistant switch (Settings.enabled, §4.4)", () => {
	it("off: nothing is searched, recommended, highlighted, armed, scheduled or queued", async () => {
		h = await createGameHarness({
			settings: {
				enabled: false,
				// Both stored "act on my behalf" defaults are on: the switch outranks them.
				automation: { autoMove: true, autoQueue: true, highlightMoves: true },
			},
		});
		const session = h.session();

		// The user asks for auto-play anyway, then a position on our turn arrives and the clock
		// runs well past any plan this time control could have produced.
		await h.sw.run(() => session.command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 2_000)).toBe(false);
		await h.advance(60_000);

		// The promise the copy makes, as the page sees it: nothing was dispatched and the board is
		// exactly as the user left it.
		expect(h.sim.debugger.commands).toEqual([]);
		expect(presses()).toHaveLength(0);
		expect(h.site.board.lastMove()).toBeNull();
		expect(session.recommendation()).toBeNull();
		expect(h.transport.goLines).toEqual([]);
		// The executor exists (it is built on `hello`, §13.4) and holds nothing.
		expect(h.executor()).not.toBeNull();
		expect(h.executor()?.pendingMove()).toBeNull();
		// Arming was refused, so the debugger never attached either (§13.4 attaches at arm time).
		expect(h.executor()?.isArmed()).toBe(false);
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(false);
		expect(h.sim.debugger.attachments).toHaveLength(0);

		// Nothing drawn, and the content script is told not to draw.
		expect(commandKinds("highlight")).toHaveLength(0);
		expect(commandKinds("arrow")).toHaveLength(0);
		expect(lastHighlightGate()).toBe(false);

		// The panel reads the switch rather than a half-started game.
		const snapshot = await h.snapshot();
		expect(snapshot.settings.enabled).toBe(false);
		expect(snapshot.recommendation).toBeUndefined();
		expect(snapshot.autoMove.armed).toBe(false);
		expect(snapshot.autoMove.scheduledAt).toBeUndefined();
		expect(snapshot.executor.debuggerAttached).toBe(false);

		// … and the auto-queue never asks the page for another game.
		await h.drive(() => h.site.endGame("1-0"));
		await h.advance(MAX_QUEUE_DELAY * 2);
		expect(commandKinds("startNewGame")).toHaveLength(0);
	});

	it("off: the panel's acting commands are refused (arm, play, re-attach)", async () => {
		h = await createGameHarness({ settings: { enabled: false } });
		const send = (message: unknown): Promise<{ success: boolean; error?: string }> =>
			h.sw.run(
				() =>
					h.router._dispatch(message, { tab: { id: h.tabId } } as never) ??
					Promise.resolve({ success: false as const, error: "nothing handled the command" })
			);

		for (const message of [
			{ type: MSG.PANEL_SET_AUTO_MOVE, tabId: h.tabId, armed: true },
			{ type: MSG.PANEL_PLAY_NOW, tabId: h.tabId },
			{ type: MSG.PANEL_REATTACH_DEBUGGER, tabId: h.tabId },
		]) {
			const envelope = await send(message);
			expect(envelope.success).toBe(false);
			expect(envelope.error).toContain(PANEL_COMMAND_ERRORS.assistantOff);
		}
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(false);
		expect(h.sim.debugger.attachments).toHaveLength(0);

		// Disarming is never refused: the switch only ever stops things.
		expect(
			(await send({ type: MSG.PANEL_SET_AUTO_MOVE, tabId: h.tabId, armed: false })).success
		).toBe(true);
	});

	it("turned off mid-think: the scheduled move never lands, the hand is released, the board cleared", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: true, highlightMoves: true } },
		});
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		expect(await h.until(() => h.executor()?.runningMove() !== null, 5_000)).toBe(true);
		// The hand is inside the move window, still exploring: nothing committed yet.
		expect(presses()).toHaveLength(0);
		expect(commandKinds("highlight").length).toBeGreaterThan(0);
		const deadline = h.session().recommendation()?.plan.deadlineMs ?? 0;
		expect(deadline).toBeGreaterThan(h.sim.now());

		// The user turns the assistant off (a panel in another window, the legacy migration, …).
		await h.patch({ enabled: false });

		// Past the deadline the move would have fired at, and well past it: nothing lands.
		await h.advance(Math.max(0, deadline - h.sim.now()) + 30_000);
		expect(presses()).toHaveLength(0);
		expect(h.site.board.lastMove()).toBeNull();
		expect(h.executor()?.runningMove() ?? null).toBeNull();
		expect(h.executor()?.pendingMove()).toBeNull();
		expect(h.executor()?.isArmed()).toBe(false);
		expect(h.session().recommendation()).toBeNull();
		// §13.4 forbids the mid-game re-attach that would let the hand act again, so the debugger
		// is released with the hand rather than left holding the infobar.
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(false);
		expect(commandKinds("clearHighlight").length).toBeGreaterThan(0);
		expect(lastHighlightGate()).toBe(false);
		const snapshot = await h.snapshot();
		expect(snapshot.autoMove.armed).toBe(false);
		expect(snapshot.autoMove.scheduledAt).toBeUndefined();
		expect(snapshot.recommendation).toBeUndefined();
	});

	it("turned off with the press committed: the hand never leaves a button held (the move may still land)", async () => {
		// The §13.4 blur-cancel contract applies here too: a press the board already accepted can
		// still be confirmed by the re-check and reported `executed`, so a flip-off *after* the
		// commit point is not a guarantee that the move does not land. What it does guarantee is
		// that the hand lets go — of the button and then of the debugger — and that nothing further
		// is searched, recommended or played.
		h = await createGameHarness({
			settings: { automation: { autoMove: true } },
		});
		await h.sw.run(() => h.session().command("armAutoMove"));
		await h.arrive();
		// Inside the drag, with the button down: the press is held for the drag's whole body.
		expect(await h.until(() => presses().length > 0, 60_000)).toBe(true);
		expect(h.sim.input.pointer(h.tabId)?.buttons).toBe(1);
		expect(mouseEvents("mouseReleased")).toHaveLength(0);

		await h.patch({ enabled: false });
		await h.advance(30_000);

		// §13: never leave a button held — and the release has to go out while the debugger is still
		// attached, so the page sees the pointer back up rather than a piece stuck to the cursor.
		expect(h.sim.input.pointer(h.tabId)?.buttons).toBe(0);
		expect(mouseEvents("mouseReleased")).toHaveLength(presses().length);
		// Only then is the debugger released.
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(false);
		expect(h.executor()?.isArmed()).toBe(false);

		// Whatever happened to the move in flight, nothing new is searched, recommended or played.
		const pressesAfterFlip = presses().length;
		const searches = h.transport.goLines.length;
		await h.arrive();
		await h.advance(30_000);
		expect(presses()).toHaveLength(pressesAfterFlip);
		expect(h.transport.goLines).toHaveLength(searches);
		expect(h.session().recommendation()).toBeNull();
		expect(h.executor()?.pendingMove()).toBeNull();
	});

	it("turned off while the ponder is starting: the search it started is stopped, not left running", async () => {
		// §6.4 / §7.4 reach the engine on the *opponent's* turn behind an await (`ponderer.start`),
		// and that await is the one window where `stopDisabled`'s own stop runs *before* the search
		// it is meant to stop exists. The session therefore re-checks the switch when the start
		// returns and stops what it just started. The window is one microtask wide, so it is driven
		// here the only way a black-box test can: two settings writes in the same turn, the second
		// landing while the first one's resume is parked inside the start.
		h = await createGameHarness({ settings: { enabled: false } });
		const session = h.session();

		// An opponent-turn position, held because the switch is off (nothing is searched for it).
		const snapshot: PositionSnapshot = {
			site: "chesscom",
			gameId: h.site.gameId,
			fen: h.site.board.fen(),
			ply: 1,
			sideToMove: "b",
			myColor: "w",
			lastMove: { from: "e2", to: "e4", san: "e4" },
			clocks: { w: { ms: 300_000, running: false }, b: { ms: 300_000, running: true } },
			timeControl: { baseMs: 300_000, incMs: 2_000 },
			capturedAt: h.sim.now(),
		};
		await h.sw.run(() => session.onPosition(snapshot));
		expect(h.transport.goLines).toEqual([]);

		// On, then off, in the same turn: the `resumeEnabled` the first write starts parks inside
		// `ponderer.start()`, and the second write's `stopDisabled` runs while it is parked.
		await h.sw.run(async () => {
			void setSettings({ enabled: true });
			void setSettings({ enabled: false });
			await h.sim.time.runMicrotasks();
		});
		await h.advance(5_000);

		// One search went out — the `go infinite` that was already on its way — and it was stopped
		// rather than left running with the assistant off. No premove search followed it either.
		expect(h.transport.goLines).toEqual(["go infinite"]);
		expect(h.transport.sent.lastIndexOf("stop")).toBeGreaterThan(
			h.transport.sent.lastIndexOf("go infinite")
		);
		expect(h.controller.status().state).toBe("idle");
		expect(h.settings().enabled).toBe(false);
		expect(session.recommendation()).toBeNull();
		expect(presses()).toHaveLength(0);
	});

	it("turned back on: the live position is picked up again and the next position is played", async () => {
		h = await createGameHarness({
			settings: { enabled: false, automation: { autoMove: true } },
		});
		const session = h.session();

		// Off: the first position of the game produces nothing.
		await h.arrive();
		await h.advance(5_000);
		expect(session.recommendation()).toBeNull();

		// On, mid-game, with that position already on the board: the session resumes from it
		// instead of waiting for a move that may never come (it is our turn).
		await h.patch({ enabled: true });
		expect(await h.until(() => session.recommendation() !== null, 10_000)).toBe(true);
		const resumed = session.recommendation();
		expect(resumed?.fen).toBe(h.site.board.fen());
		// Resuming never re-arms by itself (that would attach the debugger mid-game, §13.4).
		expect(h.executor()?.isArmed()).toBe(false);
		expect(presses()).toHaveLength(0);

		// The user arms again; the standing recommendation is scheduled and played for real.
		await h.sw.run(() => session.command("armAutoMove"));
		expect(h.executor()?.isArmed()).toBe(true);
		expect(await h.until(() => session.currentState() === "live:opponent-turn", 60_000)).toBe(true);
		expect(presses().length).toBeGreaterThan(0);
		expect(h.site.board.lastMove()?.uci).toBe(resumed?.chosen.uci ?? "");

		// And the steady state is fully back: the opponent replies, the next own position is
		// searched, recommended and played with no further help.
		await h.arrive();
		const reply = h.transport.movesFor(h.site.board.fen())[0] as string;
		const playedBefore = presses().length;
		await h.arrive(reply);
		expect(await h.until(() => session.recommendation()?.fen === h.site.board.fen(), 10_000)).toBe(
			true
		);
		const next = session.recommendation();
		expect(await h.until(() => session.currentState() === "live:opponent-turn", 60_000)).toBe(true);
		expect(presses().length).toBeGreaterThan(playedBefore);
		expect(h.site.board.lastMove()?.uci).toBe(next?.chosen.uci ?? "");
	});
});
