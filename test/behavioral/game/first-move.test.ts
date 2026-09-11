// test/behavioral/game/first-move.test.ts — Fix G: the first move must always happen.
//
// Playing white at ply 0 nothing else is coming. The position cannot change until the owner moves
// by hand, so the content script will never re-deliver it and every "not ready yet" on the my-turn
// path is permanent rather than momentary. A later move self-heals — the opponent's reply brings a
// fresh position and the whole §3.2 pipeline runs again — which is exactly why the owner only ever
// saw the *first* move go missing ("it sometimes doesnt make the first move (if youre on white)").
//
// Two holds reach the first position, and both are fixed by one mechanism (`GameSession.reconsider`,
// one re-delivery of the position the session is still sitting on):
//
//   1. the automatic arm races it. `arm()` attaches `chrome.debugger`, which is slow; the manual
//      arm (Shift+A) re-checks the standing recommendation afterwards, the automatic one used to be
//      fire-and-forget, so `actOnRecommendation` read `!executor.isArmed()`, took the panel-only
//      branch and nothing ever reconsidered;
//   2. the engine answers nothing. `runPipeline` logs "no recommendation for this position" and
//      returns, and nothing retries.
//
// The other two tests are the double-move guard: the re-check must go through the same "is a move
// already pending" gate the manual arm uses, and it must not act at all once the §3.3 machine says
// no move is owed for the position the session is holding.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
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
