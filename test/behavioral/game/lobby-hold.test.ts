// test/behavioral/game/lobby-hold.test.ts — the lobby hold (owner, 2026-09-13: "dont lock the
// mouse on …/play/online/ (no other url) if both timers are locked at 3:00 or some other time and
// arent moving - this is because this is the QUEUE screen BEFORE you've queued a game").
//
// `/play/online` shows a board with the default time control's clocks before any game has been
// queued, and the page's own game object calls it `playing`, so the adapter reports a live game
// and the session starts one. With auto-move on the hand used to arm at once — ownership
// published, the shield up, the mirror drawn — on a board nobody is playing on. Now the content
// script says the URL is the exact lobby path (`GameMeta.lobby`), and the session withholds the
// hand until the game is real: a clock tick, a move, an opponent rating or the URL moving on.
// The pure detector is `test/service/game-session/lobby.test.ts`; this file is the wiring.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { LOBBY } from "@core/constants/lobby";
import { type GamePortCommand, MSG } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import type { ExecutionReport } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const THREE = 180_000;
const STATIC = { w: THREE, b: THREE };
/** White's clock ran: the game is real. */
const TICKED = { w: THREE - 100, b: THREE };

const ownership = (): boolean[] =>
	h
		.commands()
		.filter(
			(c): c is Extract<GamePortCommand, { kind: "inputOwnership" }> => c.kind === "inputOwnership"
		)
		.map((c) => c.owned);
const cursorTos = (): number => h.commands().filter((c) => c.kind === "cursorTo").length;
const hides = (): number => h.commands().filter((c) => c.kind === "cursorHide").length;

describe("game session: the lobby hold", () => {
	it("the single panel switch remembers intent without taking the lobby mouse, and off cancels it", async () => {
		h = await createGameHarness({ lobby: true });
		await h.arrive(null, STATIC);
		await h.advance(LOBBY.clockStillMs + 500);
		const switchTo = async (armed: boolean) => {
			const request = h.drive(() =>
				h.router._dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId: h.tabId, armed }, {})
			);
			await h.advance(1000);
			expect(await request).toMatchObject({ success: true });
		};
		await switchTo(true);
		expect(h.settings().automation.autoMove).toBe(true);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership()).not.toContain(true);
		await switchTo(false);
		expect(h.settings().automation.autoMove).toBe(false);
		await h.arrive(null, TICKED);
		await h.advance(1000);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership()).not.toContain(true);
	});

	it("arriving on /play/online with auto-move on: no arm, no ownership, no mirror — until a clock ticks", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } }, lobby: true });
		await h.arrive(null, STATIC);
		await h.advance(LOBBY.clockStillMs + 500);
		// The queue screen: the owner's mouse is theirs.
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership()).not.toContain(true);
		expect(cursorTos()).toBe(0);
		expect(h.session().view().lobbyHold).toBe(true);
		// …but the debugger attached here, so its infobar shift lands outside every move window.
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(true);
		// White's clock runs: a game is on the board. The hand arms as a fresh game start would.
		await h.arrive(null, TICKED);
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		expect(ownership().at(-1)).toBe(true);
		expect(h.session().view().lobbyHold).toBeUndefined();
	});

	it("excludes pairing wait from the first move's deadline and actual release time", async () => {
		h = await createGameHarness({
			lobby: true,
			timeControl: { baseMs: THREE, incMs: 0 },
			settings: { automation: { autoMove: true }, execution: { previewSelectScale: 0 } },
			head: {
				id: "chessmimic",
				median: () => 2,
				mean: () => 2,
				sample: () => ({
					tSec: 2,
					mode: "normal",
					includesExecution: true,
					why: ["first-move elapsed-time fixture"],
				}),
			},
		});
		const reports: ExecutionReport[] = [];
		expect(h.executor()).not.toBeNull();
		h.executor()!.on("executed", (report) => reports.push(report));
		const lobbyArrivedAt = h.sim.now();
		await h.arrive(null, STATIC);
		await h.advance(LOBBY.clockStillMs + 30_000);
		expect(h.session().view().lobbyHold).toBe(true);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(reports).toHaveLength(0);

		// The board and ply are unchanged. This clock tick releases the hold, so first-arrival
		// preservation must make an exception for the time spent waiting for a pairing.
		const playStartedAt = h.sim.now();
		await h.arrive(null, TICKED);
		expect(await h.until(() => reports.length === 1, 15_000)).toBe(true);
		const { rec, result } = reports[0]!;
		expect(result.outcome).toBe("executed");
		expect(rec.computedAt).toBe(playStartedAt);
		expect(rec.computedAt).toBeGreaterThan(lobbyArrivedAt);
		expect(rec.plan.deadlineMs).toBeCloseTo(playStartedAt + rec.plan.thinkMs, 2);
		expect(rec.plan.deadlineMs).toBeGreaterThan(playStartedAt);
		expect(result.submittedAt).toBeGreaterThan(playStartedAt);
		const row = h.timingLog.entries()[0]!;
		expect(row.actualMs).toBeCloseTo(result.submittedAt! - playStartedAt, 2);
		expect(row.actualMs).toBeLessThan(playStartedAt - lobbyArrivedAt);
	});

	it("a matched game arms on its first tick, not on the opponent card that precedes it", async () => {
		// Until 2026-09-14 a readable rating ended the hold, on the reasoning that a matched game
		// shows its opponent before the first tick. It does — but the queue screen shows one too
		// (the previous opponent's card), which is how the hold came to fail open on exactly the
		// screen it exists for. A matched game loses nothing: its clock runs within a couple of
		// hundred milliseconds and a tick releases immediately, without waiting out `clockStillMs`.
		h = await createGameHarness({ settings: { automation: { autoMove: true } }, lobby: true });
		await h.arrive(null, STATIC);
		await h.advance(LOBBY.clockStillMs + 500);
		expect(h.executor()?.isArmed()).toBe(false);
		await h.drive(() => h.site.opponent({ isBot: false, name: "matched", ratingEstimate: 1450 }));
		await h.advance(500);
		expect(h.executor()?.isArmed()).toBe(false);
		await h.arrive(null, TICKED);
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		expect(ownership().at(-1)).toBe(true);
	});

	it("a board left at ply > 0 under the queue URL does not end the hold", async () => {
		// The owner's case (2026-09-14: the card read "Opponent" and the clock was frozen). No rating
		// is involved — the placeholder card has none — so what ended the hold was the *board*: the
		// finished game's moves are still on it under `/play/online`, and `ply > 0` used to read as
		// "the game is real". It is not; a clock that runs is.
		h = await createGameHarness({ settings: { automation: { autoMove: true } }, lobby: true });
		await h.arrive("e2e4", STATIC);
		await h.drive(() => h.site.opponent({ isBot: false, name: "Opponent", ratingEstimate: null }));
		await h.advance(LOBBY.clockStillMs + 500);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership()).not.toContain(true);
		expect(cursorTos()).toBe(0);
		expect(h.session().view().lobbyHold).toBe(true);
	});

	it("a `gameStarted` that omits the URL flag cannot clear one `hello` has set", async () => {
		// The flag travels as an optional `true`, so an omission means "this message does not know".
		// `gameStarted` is posted the moment the page's game object has an id, which on the queue
		// screen can be before the debounced `redetect` has seen the new URL — and clearing the flag
		// on that omission armed the hand on the lobby.
		h = await createGameHarness({ settings: { automation: { autoMove: true } }, lobby: true });
		await h.arrive(null, STATIC);
		expect(h.session().view().lobbyHold).toBe(true);
		// A fresh game id with no lobby field on it at all.
		h.site.setLobby(false);
		await h.drive(() => h.site.startGame({ gameId: "lobby-board" }));
		await h.arrive(null, STATIC);
		await h.advance(LOBBY.clockStillMs + 500);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership()).not.toContain(true);
		expect(h.session().view().lobbyHold).toBe(true);
	});

	it("a player card on the queue screen does not end the hold — only play does", async () => {
		// The regression the owner hit (2026-09-14: "prevent the bot from taking over mouse on url
		// /play/online/ (no player in game yet)"). `getOpponent` reads the *top player card*, and on
		// the queue screen that card is still the previous opponent's after an auto-queue hop back to
		// `/play/online` — so a rating is readable with no game on the board at all. A rating is
		// therefore not evidence of play; a clock that runs is.
		h = await createGameHarness({ settings: { automation: { autoMove: true } }, lobby: true });
		await h.arrive(null, STATIC);
		await h.drive(() => h.site.opponent({ isBot: false, name: "stale", ratingEstimate: 1450 }));
		await h.advance(LOBBY.clockStillMs + 500);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership()).not.toContain(true);
		expect(cursorTos()).toBe(0);
		expect(h.session().view().lobbyHold).toBe(true);
		// …and the moment a clock actually runs, the same card is a matched game and the hand arms.
		await h.arrive(null, TICKED);
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		expect(ownership().at(-1)).toBe(true);
	});

	it("the URL moving on to a game id ends the hold: the game that follows arms at once", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } }, lobby: true });
		await h.arrive(null, STATIC);
		await h.advance(LOBBY.clockStillMs + 500);
		expect(h.executor()?.isArmed()).toBe(false);
		// chess.com rewrites /play/online → /game/<id>: the content script re-says hello without
		// the flag and the adapter starts the game it now reads.
		h.site.setLobby(false);
		await h.drive(() => {
			h.site.hello();
			h.site.startGame({ gameId: "matched-game" });
		});
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		expect(ownership().at(-1)).toBe(true);
		expect(h.session().view().gameId).toBe("matched-game");
		// one arm, not one per path: the hello and the gameStarted both ended the hold
		expect(ownership().filter(Boolean)).toHaveLength(1);
	});

	it("a hand already armed is released once the clocks have proven still, and re-arms when the game is real", async () => {
		// A real game as black, armed (the opponent's turn: nothing for the hand to do yet).
		h = await createGameHarness({ settings: { automation: { autoMove: true } }, myColor: "b" });
		await h.arrive(null, STATIC);
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		const hidesBefore = hides();
		// The URL becomes the lobby (an SPA hop) with the same board under it.
		h.site.setLobby(true);
		await h.drive(() => h.site.hello());
		// Suspected, inside the grace: the hand is kept — a hop that leaves within the window must
		// not release and re-arm it for nothing.
		await h.advance(LOBBY.clockStillMs - 200);
		expect(h.executor()?.isArmed()).toBe(true);
		expect(h.session().view().lobbyHold).toBe(true);
		// Confirmed: released the way a session break releases it.
		await h.advance(400);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership().at(-1)).toBe(false);
		expect(hides()).toBeGreaterThan(hidesBefore);
		expect(h.sim.input.pointer(h.tabId)?.buttons ?? 0).toBe(0);
		// The game becomes real: the remembered arm comes back.
		await h.arrive(null, TICKED);
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		expect(ownership().at(-1)).toBe(true);
	});

	it("a manual arm on the lobby is deferred, not taken: the hand arms once the game starts", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: false } }, lobby: true });
		await h.arrive(null, STATIC);
		await h.advance(LOBBY.clockStillMs + 500);
		await h.drive(() => void h.session().command("armAutoMove"));
		await h.advance(500);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership()).not.toContain(true);
		// the debugger's infobar landed here all the same
		expect(h.debuggerManager.isAttached(h.tabId)).toBe(true);
		await h.arrive(null, TICKED);
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		expect(ownership().at(-1)).toBe(true);
	});

	it("the lobby's time-control selector is not a tick: 3 min → 5 min keeps the hold", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } }, lobby: true });
		await h.arrive(null, STATIC);
		await h.advance(LOBBY.clockStillMs + 500);
		expect(h.executor()?.isArmed()).toBe(false);
		const five = { w: 300_000, b: 300_000 };
		await h.arrive(null, five);
		await h.advance(LOBBY.clockStillMs + 500);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership()).not.toContain(true);
		expect(h.session().view().lobbyHold).toBe(true);
		// the game starts on 5 min
		await h.arrive(null, { w: 299_900, b: 300_000 });
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
	});

	it("off the lobby path there is no hold: a real game URL with still clocks at ply 0 arms at once", async () => {
		// As black at ply 0 both clocks read 3:00 until white moves — the same picture as the
		// lobby, on `/game/<id>`. The owner's rule is the URL ("no other url"), so this arms.
		h = await createGameHarness({ settings: { automation: { autoMove: true } }, myColor: "b" });
		await h.arrive(null, STATIC);
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		await h.advance(LOBBY.clockStillMs + 500);
		expect(h.executor()?.isArmed()).toBe(true);
		expect(ownership().at(-1)).toBe(true);
		expect(h.session().view().lobbyHold).toBeUndefined();
	});

	it("the auto-queue's click still goes out from the lobby, with the virtual hand, and arms nothing", async () => {
		const target = {
			targetId: "queue-button",
			rect: { left: 950, top: 650, width: 180, height: 45 },
			viewport: { width: 1280, height: 800 },
		};
		h = await createGameHarness({
			settings: { automation: { autoMove: false, autoQueue: true } },
			lobby: true,
			onCommand: (command) => {
				if (command.kind === "startNewGame")
					h.site.post({ kind: "startNewGameResult", id: command.id, status: "ready", target });
			},
		});
		h.site.dom.document.body.insertAdjacentHTML("beforeend", '<button id="queue">New Game</button>');
		h.site.dom.layout("#queue", { x: 950, y: 650, width: 180, height: 45 });
		let clicks = 0;
		h.site.dom.query("#queue").addEventListener("click", () => {
			clicks++;
			h.site.startGame({ gameId: "queued-from-the-lobby" });
		});
		await h.arrive(null, STATIC);
		await h.advance(LOBBY.clockStillMs + 500);
		expect(h.session().view().lobbyHold).toBe(true);
		await h.drive(() => h.site.endGame("1-0"));
		expect(await h.until(() => clicks === 1, TIMINGS.autoQueueDelayRangeMs[1] + 5_000)).toBe(true);
		await h.advance(100);
		const mouse = h.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent);
		expect(mouse.filter((command) => command.params?.type === "mouseMoved").length).toBeGreaterThan(
			10
		);
		expect(mouse.filter((command) => command.params?.type === "mousePressed")).toHaveLength(1);
		expect(mouse.filter((command) => command.params?.type === "mouseReleased")).toHaveLength(1);
		expect(cursorTos()).toBeGreaterThan(10);
		expect(h.session().view().gameId).toBe("queued-from-the-lobby");
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership()).not.toContain(true);
		expect(h.sim.input.pointer(h.tabId)?.buttons).toBe(0);
	});
});
