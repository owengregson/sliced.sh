// test/behavioral/game/first-move.test.ts — Fix G: the first move must always happen.
//
// Playing white at ply 0 nothing else is coming. The position cannot change until the owner moves
// by hand, so the content script will never re-deliver it and every "not ready yet" on the my-turn
// path is permanent rather than momentary. A later move self-heals — the opponent's reply brings a
// fresh position and the whole §3.2 pipeline runs again — which is exactly why the owner only ever
// saw the *first* move go missing ("it sometimes doesnt make the first move (if youre on white)").
//
// Three holds reach the first position, and one mechanism covers them — `GameSession.reconsider`,
// one re-delivery of the position the session is still sitting on:
//
//   1. the automatic arm races it. `arm()` attaches `chrome.debugger`, which is slow; the manual
//      arm (Shift+A) re-checks the standing recommendation afterwards, the automatic one used to be
//      fire-and-forget, so `actOnRecommendation` read `!executor.isArmed()`, took the panel-only
//      branch and nothing ever reconsidered;
//   2. the engine answers nothing. `runPipeline` logs "no recommendation for this position" and
//      returns, and nothing retries;
//   3. the page was not focused when the move was due, so §13.4's hand skipped it and waited for a
//      position that never comes. Released on the owner's own refocus — his ruling of 2026-09-10,
//      scoped to move one, guarded so a blur *inside* the window still cancels
//      (`docs/qa/focus-discipline.md` §4).
//
// The rest of the file is the double-move gate and the scope of that ruling. Every re-delivery goes
// through the same "is a move already pending" check the manual arm uses and the same §3.3 answer to
// "is a move still owed", and every call site into it — the automatic arm, Shift+A, the panel's
// auto-move toggle and the panel's play-now — is covered here, because the gate having three
// hand-written copies is what made the bug class possible in the first place.
import { afterEach, describe, expect, it } from "bun:test";
import { sideToMove } from "@core/chess/fen";
import { CDP, EXECUTOR, PANEL_COMMAND_ERRORS } from "@core/constants/cdp";
import { MSG } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import {
	__setLogSinkOutsideServiceWorker,
	clearLogSink,
	type LogEntry,
	setLogSink,
} from "@core/logger";
import type { MoveContext } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

/**
 * Hold every `chrome.debugger.attach` — the slow half of `executor.arm()`, and the reason an
 * automatic arm is still in flight when the first position arrives. The returned function restores
 * the real `attach` and lets the held calls through (call it inside the worker context: the
 * simulator settles a callback against whichever context is active).
 */
function holdAttach(harness: GameHarness): () => void {
	const api = harness.sim.chrome.debugger as unknown as {
		attach: (target: chrome.debugger.Debuggee, version: string, cb?: () => void) => unknown;
	};
	const real = api.attach.bind(api);
	const held: Array<() => void> = [];
	api.attach = (target, version, cb): unknown => {
		held.push(() => void real(target, version, cb));
		return undefined;
	};
	return (): void => {
		api.attach = real;
		for (const release of held.splice(0)) release();
	};
}

/**
 * The next `n` own-move searches answer `bestmove (none)` with no `info` lines: Stockfish is up but
 * has nothing to say yet (a crashed-and-recovering search, or a net still loading), which is what
 * leaves `RecommendationPipeline.run` with no usable line and no book move. Two covers one search
 * and the §7.5 shallow retry it drags behind it.
 */
function blankSearches(harness: GameHarness, n: number): void {
	const transport = harness.transport;
	const real = transport.send.bind(transport);
	let left = n;
	transport.send = (line: string): void => {
		if (left > 0 && line.startsWith("go") && !line.includes("infinite")) {
			left -= 1;
			transport.goLines.push(line);
			queueMicrotask(() => transport.feed("bestmove (none)"));
			return;
		}
		real(line);
	};
}

/** The session's own "I gave up on this position" line (`retryWhenReady`'s spent budget). */
function gaveUp(warnings: readonly LogEntry[]): boolean {
	return warnings.some(
		(entry) => typeof entry.args[0] === "string" && entry.args[0].includes("nothing became ready")
	);
}

/** `PANEL_SET_AUTO_MOVE` as the side panel sends it, through the installed router. */
function setAutoMove(armed: boolean): Promise<unknown> | undefined {
	return h.router._dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId: h.tabId, armed }, {});
}

/**
 * A raw `position` of the shape the adapter really can publish: the page's own FEN with whatever
 * `ply` and `gameId` the test wants. `ply` is `plyOf(readMoveList(document))` in production and is
 * **0** whenever the move-list element cannot be found — which on `/play/online` also bumps the
 * adapter's game serial, so a mid-game board can publish `ply: 0` under a fresh `gameId`.
 */
function postPosition(over: {
	gameId?: string;
	ply?: number;
	fen?: string;
	approximate?: boolean;
	clockMs?: number;
}): void {
	const board = h.site.board;
	const fen = over.fen ?? board.fen();
	const clockMs = over.clockMs ?? 300_000;
	h.site.post({
		kind: "position",
		snapshot: {
			site: "chesscom",
			gameId: over.gameId ?? h.site.gameId,
			fen,
			ply: over.ply ?? board.ply(),
			sideToMove: sideToMove(fen) ?? board.myColor,
			myColor: board.myColor,
			...(over.approximate === undefined ? {} : { approximate: over.approximate }),
			clocks: { w: { ms: clockMs, running: true }, b: { ms: clockMs, running: true } },
			capturedAt: h.sim.now(),
		},
	});
}

/** `PANEL_PLAY_NOW` as the side panel sends it, through the installed router. */
function playNow(): Promise<unknown> | undefined {
	return h.router._dispatch({ type: MSG.PANEL_PLAY_NOW, tabId: h.tabId }, {});
}

/** Own-move searches the client issued (`go infinite` is a ponder, not one of ours). */
const ownMoveSearches = (): number =>
	h.transport.goLines.filter((line) => !line.includes("infinite")).length;

/** Every `mousePressed` the hand dispatched — nonzero means a move was really attempted. */
const presses = (): unknown[] =>
	h.sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mousePressed"
	);

/** `hello` + `gameStarted` with the automatic arm already in flight (both arms are held). */
async function openGameWithTheArmInFlight(): Promise<void> {
	await h.drive(() => {
		h.site.hello();
		h.site.startGame();
	});
	// The arm really is in flight: the attach has not answered, so the hand is not armed yet.
	expect(h.debuggerManager.isAttached(h.tabId)).toBe(false);
	expect(h.executor()?.isArmed()).toBe(false);
}

describe("game session: the first move as white (Fix G)", () => {
	it("the automatic arm races the first position: the recommendation is acted on when the arm lands", async () => {
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		const release = holdAttach(h);
		await openGameWithTheArmInFlight();
		const session = h.session();

		// The first position of the game: ours, as white, with the arm still attaching.
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		// The exact shape of the bug: a recommendation stands, the hand is not armed, and nothing is
		// scheduled. Before the fix this is where the game stopped for good.
		expect(session.currentState()).toBe("live:my-turn:recommended");
		expect(h.executor()?.isArmed()).toBe(false);
		expect(h.executor()?.pendingMove()).toBeNull();
		expect(presses()).toHaveLength(0);

		// The attach lands. Nothing else will ever deliver this position again.
		const stood = session.recommendation()?.chosen.uci;
		const searches = ownMoveSearches();
		await h.drive(() => release());
		expect(h.executor()?.isArmed()).toBe(true);

		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);
		const played = h.site.board.lastMove();
		expect(played?.byMe).toBe(true);
		// The recommendation that was standing is the one that gets played, not a fresh one: the
		// re-delivery *acts on* what was withheld, and searching again would spend clock the first
		// move does not have and could pick a different move than the panel is showing.
		expect(played?.uci).toBe(stood);
		expect(ownMoveSearches()).toBe(searches);
		expect(h.site.board.chess.history()).toHaveLength(1);
	});

	it("the engine answers nothing for the first position: a later search is acted on", async () => {
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		// One search plus the §7.5 shallow retry behind it, both answering nothing.
		blankSearches(h, 2);
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		await h.arrive();
		// The pipeline ran and produced nothing: the session is still `analysing`, with no
		// recommendation and nothing scheduled, and before the fix nothing re-ran it.
		await h.advance(0);
		expect(session.recommendation()).toBeNull();
		expect(session.currentState()).toBe("live:my-turn:analysing");
		expect(h.executor()?.pendingMove()).toBeNull();

		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);
		expect(h.site.board.lastMove()?.byMe).toBe(true);
		expect(session.recommendation()).not.toBeNull();
		expect(h.site.board.chess.history()).toHaveLength(1);
	});

	it("two automatic arms land on the same recommendation: the move is scheduled once", async () => {
		// The pre-game executor (`hello`, §13.4's "armable in the waiting view") and the game's own
		// (`gameStarted`) each fire an automatic arm, and both resolve off the one held attach — so
		// the post-arm re-check runs twice for one recommendation. The "is a move already pending"
		// gate is what makes the second one a no-op; without it the second `schedule` replaces a
		// move that was already this position's answer, and behind a cancelled run it would park a
		// second piece.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		const release = holdAttach(h);
		await openGameWithTheArmInFlight();
		const session = h.session();
		const executor = h.executor();
		if (!executor) throw new Error("first-move: the session has no executor");
		let schedules = 0;
		const realSchedule = executor.schedule.bind(executor);
		executor.schedule = (rec, plan, ctx): void => {
			schedules += 1;
			realSchedule(rec, plan, ctx);
		};

		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(schedules).toBe(0);

		await h.drive(() => release());
		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);

		expect(schedules).toBe(1);
		expect(h.site.board.chess.history()).toHaveLength(1);
		expect(h.site.board.lastMove()?.byMe).toBe(true);
	});

	it("the engine never answers: the retries are bounded and the session says so at warn", async () => {
		// The other half of "do not sit silently": the retry is a second chance, not a poll. Every
		// search answers nothing for the whole test, so the budget is spent and the session has to
		// stop and say why — at `warn`, which is what the panel's log stream renders
		// (`COPY.engine.logKinds.warn`). No new string and no new inert UI.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		blankSearches(h, Number.POSITIVE_INFINITY);
		const warnings: LogEntry[] = [];
		const sink = (entry: LogEntry): void => {
			if (entry.level === "warn") warnings.push(entry);
		};
		__setLogSinkOutsideServiceWorker(true);
		setLogSink(sink);
		try {
			await h.drive(() => {
				h.site.hello();
				h.site.startGame();
			});
			expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);
			await h.arrive();
			expect(await h.until(() => gaveUp(warnings), 20_000)).toBe(true);

			// One own-move search per run, each dragging the §7.5 shallow retry behind it: the first
			// run plus exactly `sessionRetryMax` re-deliveries, and then it stops asking.
			const searches = h.transport.goLines.filter((line) => !line.includes("infinite"));
			expect(searches).toHaveLength(2 * (TIMINGS.sessionRetryMax + 1));
			await h.advance(TIMINGS.sessionRetryMs * 10);
			expect(h.transport.goLines.filter((line) => !line.includes("infinite"))).toHaveLength(
				searches.length
			);
			expect(h.site.board.lastMove()).toBeNull();
		} finally {
			clearLogSink(sink);
			__setLogSinkOutsideServiceWorker(false);
		}
	});

	it("the retry budget belongs to the position: a later one gets its own", async () => {
		// `cancelInFlight` drops the pending re-delivery *and* its budget, so a game whose first
		// position spent the whole allowance is not left unable to retry for the rest of its length.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		blankSearches(h, Number.POSITIVE_INFINITY);
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		await h.arrive();
		const spent = 2 * (TIMINGS.sessionRetryMax + 1);
		expect(await h.until(() => ownMoveSearches() >= spent, 20_000)).toBe(true);

		// The owner plays by hand and the opponent replies: our turn again, on a fresh position.
		await h.drive(() => {
			expect(h.site.board.submit("e2", "e4")).toBe(true);
		});
		await h.arrive();
		await h.advance(TIMINGS.sessionRetryMs * 8); // the opponent-turn searches settle
		h.transport.goLines.splice(0); // measure only what the next own-move position asks for
		await h.arrive("e7e5");

		// More than the one run plus its §7.5 shallow retry: this position re-delivered too.
		expect(await h.until(() => ownMoveSearches() > 2, 20_000)).toBe(true);
	});

	it("Shift+A twice while the attach is in flight schedules once", async () => {
		// The second call site of the gate. The owner, seeing nothing happen, presses arm again: two
		// `arm()` calls await the one held attach and both re-check the same recommendation.
		h = await createGameHarness({ manualStart: true });
		const release = holdAttach(h);
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		const executor = h.executor();
		if (!executor) throw new Error("first-move: the session has no executor");
		let schedules = 0;
		const realSchedule = executor.schedule.bind(executor);
		executor.schedule = (rec, plan, ctx): void => {
			schedules += 1;
			realSchedule(rec, plan, ctx);
		};

		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		// Nothing arms automatically here (`automation.autoMove` is off): both arms are the owner's.
		expect(h.executor()?.isArmed()).toBe(false);
		await h.drive(() => {
			void session.command("armAutoMove");
			void session.command("armAutoMove");
		});
		expect(schedules).toBe(0); // both are still waiting on the attach

		await h.drive(() => release());
		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);
		expect(schedules).toBe(1);
		expect(h.site.board.chess.history()).toHaveLength(1);
	});

	it("the panel's auto-move toggle schedules through the session, with the move context", async () => {
		// The third call site. `PANEL_SET_AUTO_MOVE` used to arm and then schedule *itself*, with a
		// hand-written copy of the gate and — because only the session can build one — no
		// `MoveContext`: no candidates, no legal destinations, no clock, so the §13.2 exploration had
		// nothing to plan from. It goes through the session now.
		h = await createGameHarness({ manualStart: true });
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		const executor = h.executor();
		if (!executor) throw new Error("first-move: the session has no executor");
		const contexts: Array<MoveContext | undefined> = [];
		const realSchedule = executor.schedule.bind(executor);
		executor.schedule = (rec, plan, ctx): void => {
			contexts.push(ctx);
			realSchedule(rec, plan, ctx);
		};

		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(contexts).toHaveLength(0);

		// Two toggles, as the panel would send them if the owner double-clicked: still one schedule.
		await h.drive(() => {
			void setAutoMove(true);
			void setAutoMove(true);
		});
		expect(await h.until(() => contexts.length > 0, 5_000)).toBe(true);

		expect(contexts).toHaveLength(1);
		const ctx = contexts[0];
		expect(ctx).toBeDefined();
		expect(ctx?.candidates?.length ?? 0).toBeGreaterThan(0);
		expect(typeof ctx?.legalDestinations).toBe("function");
		expect(ctx?.myClockMs).toBeGreaterThan(0);
		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);
		expect(h.site.board.chess.history()).toHaveLength(1);
	});

	it("the page was not focused when the first position arrived: the move plays when the owner clicks back in", async () => {
		// §13.4 makes the hand skip a move the page was not focused for and wait for a fresh position
		// — and at the game's first move there is no fresh position. The owner ruled on 2026-09-10
		// that move one may be played when focus comes back (and only move one): his first move
		// usually does carry a focus change, because he has just clicked to start the game.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		// Focus leaves the page *before* the position arrives — the owner is in the side panel, so the
		// move window opens with no focus and no blur inside it.
		await h.drive(() => h.site.panelClick());
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		// The hand refuses before its first dispatch (`FocusGate.canExecute` → `unfocused`).
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);
		await h.advance(5_000);
		expect(presses()).toHaveLength(0);
		expect(h.site.board.lastMove()).toBeNull();

		// The owner clicks back into the board. Nothing else will ever deliver this position.
		await h.drive(() => h.site.clickIntoBoard());
		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);
		expect(h.site.board.lastMove()?.byMe).toBe(true);
		expect(h.site.board.chess.history()).toHaveLength(1);
	});

	it("a blur inside the first move's window still cancels it: clicking back in does not play it", async () => {
		// The half of the ruling that is not a relaxation. A blur that actually lands in the window is
		// what chess.com counts against the move (§13.2 `DidToggle`): that move is spent, and its
		// second chance is the next position, not this click.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		const executor = h.executor();
		if (!executor) throw new Error("first-move: the session has no executor");
		expect(await h.until(() => executor.isArmed(), 5_000)).toBe(true);
		let schedules = 0;
		const realSchedule = executor.schedule.bind(executor);
		executor.schedule = (rec, plan, ctx): void => {
			schedules += 1;
			realSchedule(rec, plan, ctx);
		};

		// The position arrives with the page focused, so the window opens clean…
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(schedules).toBe(1);
		// …and the owner then clicks the side panel *inside* the window.
		await h.drive(() => h.site.panelClick());
		expect(executor.pendingMove()).toBeNull();

		await h.drive(() => h.site.clickIntoBoard());
		await h.advance(60_000);
		expect(schedules).toBe(1); // not re-scheduled: the blur is inside this move's window
		expect(h.site.board.lastMove()).toBeNull();
	});

	it("a later move is not released by focus: only move one is", async () => {
		// The scope of the ruling. This is §13.4's unchanged behaviour for every move but the first,
		// and it is what `isGameFirstMove` exists to keep.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		// Move one plays normally, with focus throughout.
		await h.arrive();
		expect(await h.until(() => h.site.board.chess.history().length === 1, 60_000)).toBe(true);
		const afterMoveOne = [...h.site.board.chess.history()];

		// The opponent replies while the owner is in the side panel: our *second* move's window opens
		// with no focus and no blur inside it — the same shape as the first test.
		await h.drive(() => h.site.panelClick());
		await h.arrive("e7e5");
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);

		// Clicking back in must not play it: §13.4 says it waits for a fresh position.
		await h.drive(() => h.site.clickIntoBoard());
		await h.advance(60_000);
		expect(h.site.board.chess.history()).toEqual([...afterMoveOne, "e5"]);
	});

	it("the panel's play-now goes through the session, with the move context", async () => {
		// The same defect as the auto-move toggle's, one call site over: `PANEL_PLAY_NOW` called
		// `executor.playNow(rec, rec.plan)` itself — no `MoveContext`, so the hand had no candidates,
		// no legal destinations and no clock, and no `TimingModel.replan` either.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		const executor = h.executor();
		if (!executor) throw new Error("first-move: the session has no executor");
		expect(await h.until(() => executor.isArmed(), 5_000)).toBe(true);
		const contexts: Array<MoveContext | undefined> = [];
		const realPlayNow = executor.playNow.bind(executor);
		executor.playNow = (rec, plan, ctx) => {
			contexts.push(ctx);
			return realPlayNow(rec, plan, ctx);
		};

		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);

		await h.drive(() => void playNow());
		expect(contexts).toHaveLength(1);
		const ctx = contexts[0];
		expect(ctx).toBeDefined();
		expect(ctx?.candidates?.length ?? 0).toBeGreaterThan(0);
		expect(typeof ctx?.legalDestinations).toBe("function");
		expect(ctx?.myClockMs).toBeGreaterThan(0);
	});

	it("the panel's play-now with nothing to play is refused, and queues nothing", async () => {
		// The other half of `playNowRequested`: `false` means "there was nothing to play", which the
		// handler turns into `noRecommendation`. Unlike the keybind path it must not queue
		// `playWhenReady` — a command the panel is waiting on answers now or says why not.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);
		// Armed in the waiting view, no position yet: nothing is pending and nothing is recommended.
		expect(session.recommendation()).toBeNull();
		expect(h.executor()?.pendingMove()).toBeNull();

		const reply = (await h.drive(() => playNow())) as { success: boolean; error?: string };
		expect(reply.success).toBe(false);
		expect(reply.error).toContain(PANEL_COMMAND_ERRORS.noRecommendation);
		await h.advance(5_000);
		expect(presses()).toHaveLength(0);
	});

	it("a mid-game FEN published with ply 0 is not move one", async () => {
		// The scope of the ruling must come from the bridge FEN, not from the adapter's move-list ply.
		// `readMoveList` answers `{ sans: [] }` when the list element is missing, `plyOf` then says 0,
		// and on `/play/online` (no URL game id) that also bumps the game serial — so a mid-game board
		// publishes `ply: 0` under a fresh `gameId` and the session starts a "new game". Scoping on
		// `snapshot.ply` would hand every remaining move of that game the first-move relaxation the
		// owner declined.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		// Play two real moves, so the board is genuinely mid-game.
		await h.arrive();
		expect(await h.until(() => h.site.board.chess.history().length === 1, 60_000)).toBe(true);
		await h.arrive("e7e5");
		expect(await h.until(() => h.site.board.chess.history().length === 3, 60_000)).toBe(true);
		// One more opponent move straight onto the board, so the spurious position below is *our* turn
		// on a genuinely mid-game board.
		await h.drive(() => {
			const reply = h.site.board.legalMoves()[0];
			if (reply === undefined) throw new Error("first-move: no legal opponent move");
			h.site.board.applyOpponent(reply);
		});
		const midGame = [...h.site.board.chess.history()];
		expect(midGame).toHaveLength(4);
		expect(h.site.board.ply()).toBeGreaterThan(1);

		// The owner switches the right-hand panel to Chat and the move list goes away: the adapter
		// publishes the real mid-game FEN with a false ply, under a bumped serial. And he is in the
		// side panel while it happens, so the new "first" window opens unfocused with no blur in it.
		await h.drive(() => h.site.panelClick());
		await h.drive(() => postPosition({ gameId: `${h.site.gameId}#2`, ply: 0 }));
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(session.view().ply).toBe(0); // the session really believes the false ply
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);

		// Clicking back in must not release it: the FEN says fullmove 3, whatever the ply says.
		await h.drive(() => h.site.clickIntoBoard());
		await h.advance(60_000);
		expect(h.site.board.chess.history()).toEqual(midGame);
	});

	it("a republish of the same ply-0 position does not clear the blur hold", async () => {
		// The companion guard has to outlive the thing that always happens at move one: the colour and
		// the time control arrive on a *republish of the unmoved ply-0 position*, and `positionArrived`
		// reopens `FocusGate`'s window on every accepted position. A §13.4 permission cannot hang off a
		// flag that the normal case clears.
		h = await createGameHarness({
			manualStart: true,
			timeControl: null, // the site has not answered `timeControl.get()` yet (§4.3)
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		// A blur *inside* the first move's window: this move is spent (§13.2).
		await h.drive(() => h.site.panelClick());
		expect(h.executor()?.pendingMove()).toBeNull();

		// Now the game "starts" on the site and the clock arrives — the same ply 0, republished.
		await h.drive(() => h.site.setTimeControl({ baseMs: 300_000, incMs: 2_000 }));
		await h.arrive();
		expect(session.view().ply).toBe(0);
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);

		await h.drive(() => h.site.clickIntoBoard());
		await h.advance(60_000);
		expect(h.site.board.lastMove()).toBeNull();
	});

	it("a republished ply does not release the blur hold either", async () => {
		// The blur is remembered against the FEN, not the ply, for the same reason the scope is: the
		// adapter's ply can come back wrong on a position that has not moved, and a lying ply would
		// make the remembered blur stop matching and release a move that must stay held.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		await h.drive(() => h.site.panelClick()); // a blur inside the first move's window
		expect(h.executor()?.pendingMove()).toBeNull();

		// The same start position, republished with a different ply — still fullmove 1, so still
		// move one as far as the ruling's scope is concerned.
		await h.drive(() => postPosition({ ply: 1 }));
		expect(session.view().ply).toBe(1);
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);

		await h.drive(() => h.site.clickIntoBoard());
		await h.advance(60_000);
		expect(h.site.board.lastMove()).toBeNull();
	});

	it("the assistant turned off between the hold and the release: nothing is searched or played", async () => {
		// §4.4 inside `reconsider`. `stopDisabled` disarms the hand and drops the recommendation but
		// leaves the state at `recommended`, so without the switch check the release would re-run the
		// pipeline — an engine search, on the page, with the assistant off.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		const release = holdAttach(h);
		await openGameWithTheArmInFlight();
		const session = h.session();
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);

		await h.patch({ enabled: false });
		expect(session.recommendation()).toBeNull();
		const searches = ownMoveSearches();

		// The arm lands after the switch went off.
		await h.drive(() => release());
		await h.advance(10_000);
		expect(ownMoveSearches()).toBe(searches);
		expect(h.executor()?.pendingMove()).toBeNull();
		expect(presses()).toHaveLength(0);
		expect(h.site.board.lastMove()).toBeNull();
	});

	it("the released first move is re-planned for the wait, not collapsed to the floor", async () => {
		// `rec.plan.deadlineMs` is in the past by definition once a move has been withheld, and
		// `MoveExecutor.schedule` collapses such a plan to `EXECUTOR.minExecutionMs`. A first move that
		// always lands a constant quarter-second after the click is a sharper machine signature than
		// the ones §13.2 spends its effort removing, so the re-delivery re-plans.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		await h.drive(() => h.site.panelClick());
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		const planned = session.recommendation()?.plan.thinkMs ?? 0;
		const arrivedAt = h.sim.now();
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);

		// The owner is away far longer than the move was planned to take.
		const AWAY_MS = 20_000;
		await h.advance(AWAY_MS);
		expect(AWAY_MS).toBeGreaterThan(planned);
		const away = h.sim.now() - arrivedAt;
		await h.drive(() => h.site.clickIntoBoard());

		const plan = session.recommendation()?.plan;
		expect(plan?.thinkMs ?? 0).toBeGreaterThanOrEqual(away);
		expect(plan?.thinkMs ?? 0).toBeGreaterThan(EXECUTOR.minExecutionMs);
		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);
	});

	it("a re-delivery that throws is logged, not left as an unhandled rejection", async () => {
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		const release = holdAttach(h);
		await openGameWithTheArmInFlight();
		const session = h.session();
		const executor = h.executor();
		if (!executor) throw new Error("first-move: the session has no executor");
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);

		// The re-delivery is reached from an arm's `.then` and from `onCommand` / `onKeybind`, where a
		// rejection would be unhandled; two of its triggers replaced synchronous code.
		executor.schedule = (): void => {
			throw new Error("schedule exploded");
		};
		const warnings: LogEntry[] = [];
		const sink = (entry: LogEntry): void => {
			if (entry.level === "warn") warnings.push(entry);
		};
		__setLogSinkOutsideServiceWorker(true);
		setLogSink(sink);
		try {
			await h.drive(() => release());
			await h.advance(1_000);
			expect(
				warnings.some(
					(e) =>
						typeof e.args[0] === "string" && e.args[0].includes("acting on the held position failed")
				)
			).toBe(true);
		} finally {
			clearLogSink(sink);
			__setLogSinkOutsideServiceWorker(false);
		}
		// And the session is still usable: its state machine did not move to anything terminal.
		expect(session.currentState()).toBe("live:my-turn:recommended");
	});

	it("the panel's play-now answers before the hand has finished", async () => {
		// The reply must not be held for the length of a move: the outcome reaches the panel through
		// the broadcaster (`lastExecution` + toast), not through this reply.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);

		const reply = (await h.drive(() => playNow())) as { success: boolean };
		expect(reply.success).toBe(true);
		// The hand has the move and is working on it; the board has not changed yet.
		expect(h.site.board.lastMove()).toBeNull();
		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);
	});

	it("the page's focus state is known before any focus edge", async () => {
		// `FocusGate.canExecute` answers `unfocused` while it has no reading at all, and the reading
		// only ever came from the content script's `focus` message — which `installFocusEdges` used to
		// send only on an actual edge. A tab that was already focused when the content script loaded,
		// armed with the `Shift+A` shortcut (no focus edge, by design), therefore had every move
		// skipped with nothing to release it.
		h = await createGameHarness({ manualStart: true });
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		// Nothing has blurred or focused the page: this is the install report alone.
		expect((await h.snapshot()).focus.pageHasFocus).toBe(true);

		const session = h.session();
		await h.drive(() => void session.command("armAutoMove"));
		expect(h.executor()?.isArmed()).toBe(true);
		await h.arrive();
		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);
		expect(h.site.board.lastMove()?.byMe).toBe(true);
	});

	it("disposing the session drops its pending re-delivery (C6)", async () => {
		// A timer must not outlive the module that armed it. `reconsider` returns early on `disposed`
		// so a leaked retry is invisible behaviourally — the timer itself is the assertion.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		blankSearches(h, Number.POSITIVE_INFINITY);
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		const before = h.sim.time.pendingTimers();
		await h.arrive(); // the search answers nothing, so one re-delivery is armed
		await h.advance(0);
		const armed = h.sim.time.pendingTimers();
		expect(armed).toBe(before + 1);

		await h.drive(() => h.session().dispose());
		expect(h.sim.time.pendingTimers()).toBe(before);
	});

	it("an approximate FEN is never move one, whatever its counters say", async () => {
		// The residual of the same root cause. `positionInfoFor`'s DOM fallback writes
		// `fullmove = Math.floor(ply / 2) + 1`, so an unreadable move list publishes a *mid-game
		// placement with fullmove 1* — a FEN that parses and reads as the first move. The flag that says
		// "the adapter reconstructed this" now travels with the snapshot, and a reconstruction is not
		// evidence about a move counter.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		await h.drive(() => h.site.panelClick());
		// The real start position — so the *counters* say move one — published as a reconstruction.
		await h.drive(() => postPosition({ approximate: true }));
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);

		await h.drive(() => h.site.clickIntoBoard());
		await h.advance(60_000);
		expect(h.site.board.lastMove()).toBeNull();
	});

	it("a FEN that cannot be parsed is never move one", async () => {
		// The refusal direction of the predicate that closes all of this: no reading is not a reading
		// that says yes.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		await h.drive(() => h.site.panelClick());
		await h.arrive(); // a real ply-0 position, so a recommendation stands and the hand skips it
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);
		// …and then the same ply republished with a FEN nothing can read. Let that position's own move
		// be scheduled and skipped too, so the click is the only thing left that could release it.
		await h.drive(() => postPosition({ fen: "not a fen at all", ply: 0 }));
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);
		expect(h.site.board.lastMove()).toBeNull();

		await h.drive(() => h.site.clickIntoBoard());
		await h.advance(60_000);
		expect(h.site.board.lastMove()).toBeNull();
	});

	it("the re-planned think never exceeds the clock the move started with", async () => {
		// `engine-not-ready` folds the wait into the think and caps nothing, so a wait longer than the
		// clock would record a §8.6 row claiming a think the clock could not have afforded — and that
		// number is what `report.py`'s think bands read.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);

		const CLOCK_MS = 4_000;
		await h.drive(() => h.site.panelClick());
		await h.arrive(null, { w: CLOCK_MS, b: CLOCK_MS });
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(await h.until(() => h.executor()?.pendingMove() === null, 60_000)).toBe(true);

		await h.advance(30_000); // away far longer than the whole clock
		await h.drive(() => h.site.clickIntoBoard());
		const thinkMs = session.recommendation()?.plan.thinkMs ?? 0;
		expect(thinkMs).toBeGreaterThan(0);
		expect(thinkMs).toBeLessThanOrEqual(CLOCK_MS);
	});

	it("the re-delivery gate consults the hand's own run, not only the state", async () => {
		// There is a real window in which `isRunning()` is true, `pendingMove()` is null and the state
		// is back at `recommended`: `runOne` emits its terminal event — which `onNotExecuted` turns into
		// `failed`, i.e. `executing` → `recommended` — before `execute`'s `finally` clears `running`. It
		// is a microtask or two wide and no trigger can be driven into it, so the property is asserted
		// directly instead: the gate must ask.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		const release = holdAttach(h);
		await openGameWithTheArmInFlight();
		const session = h.session();
		const executor = h.executor();
		if (!executor) throw new Error("first-move: the session has no executor");
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(session.currentState()).toBe("live:my-turn:recommended");

		let schedules = 0;
		const realSchedule = executor.schedule.bind(executor);
		executor.schedule = (rec, plan, ctx): void => {
			schedules += 1;
			realSchedule(rec, plan, ctx);
		};
		executor.isRunning = (): boolean => true;
		executor.pendingMove = (): null => null;

		await h.drive(() => release());
		await h.advance(10_000);
		expect(schedules).toBe(0);
	});

	it("play-now answers false rather than true when the hand cannot take the move", async () => {
		// `playNowRequested` tells the panel `true` on the strength of `hasPlayableMove()`, so that
		// predicate has to be every condition `playNow()` itself checks — §4.4's switch and §13.4's
		// armed hand included — or the panel is told a move was handed over when none was.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		const session = h.session();
		expect(await h.until(() => h.executor()?.isArmed() === true, 5_000)).toBe(true);
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);
		expect(await h.until(() => h.site.board.lastMove() !== null, 60_000)).toBe(true);
		const played = [...h.site.board.chess.history()];

		// A recommendation still stands, but the hand is no longer armed.
		await h.drive(() => void session.command("disarm"));
		expect(h.executor()?.isArmed()).toBe(false);
		expect(session.recommendation()).not.toBeNull();
		expect(await h.drive(() => session.playNowRequested())).toBe(false);

		// And with the hand armed but the assistant off.
		await h.patch({ enabled: false });
		expect(await h.drive(() => session.playNowRequested())).toBe(false);
		await h.advance(10_000);
		expect(h.site.board.chess.history()).toEqual(played);
	});

	it("the owner played the first move by hand while the arm was in flight: nothing is dispatched", async () => {
		// The §3.3 machine, not the snapshot, is what says whether a move is still owed: once the
		// owner has played, `this.snapshot` and `this.rec` still describe the position we were about
		// to move in, and running the pipeline on them would recommend — and an armed hand would
		// play — a move for the *opponent*.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: true } },
		});
		const release = holdAttach(h);
		await openGameWithTheArmInFlight();
		const session = h.session();

		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 5_000)).toBe(true);

		// The owner gets bored and plays e4 themselves; the page publishes the new position.
		await h.drive(() => {
			expect(h.site.board.submit("e2", "e4")).toBe(true);
		});
		await h.arrive();
		expect(session.currentState()).toBe("live:opponent-turn");

		// The arm lands on a position that is no longer ours.
		await h.drive(() => release());
		expect(h.executor()?.isArmed()).toBe(true);
		await h.advance(30_000);

		// Nothing was recommended for the opponent's position (the panel would have shown it as
		// *our* move), nothing was scheduled and the hand never touched the page. The board is still
		// the owner's own move.
		expect(session.recommendation()).toBeNull();
		expect(session.currentState()).toBe("live:opponent-turn");
		expect(h.executor()?.pendingMove()).toBeNull();
		expect(presses()).toHaveLength(0);
		expect(h.site.board.chess.history()).toEqual(["e4"]);
	});
});
