// test/behavioral/game/opponent-moves-during-plan.test.ts — Task 30 Step 2 (b): a position that
// arrives while our plan is still pending cancels it and starts a fresh analysis (Appendix E
// §4.4: the running search is stopped, its result superseded, nothing is played on a stale board).
import { afterEach, describe, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
import { CDP } from "@core/constants/cdp";
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

describe("game session: the opponent moves while our plan is pending (Step 2b)", () => {
	it("cancels the pending execution, analyses the new position and never plays the stale move", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		const session = h.session();
		await h.arrive();
		expect(await h.until(() => h.executor()?.runningMove() !== null, 10_000)).toBe(true);
		const stale = session.recommendation();
		expect(stale).not.toBeNull();
		expect(presses()).toHaveLength(0); // still inside the pre-touch window

		// The board moved on: our move is no longer to be played on this position.
		const start = h.site.board.fen();
		const moved = applyMoves(start, ["e2e4", "e7e5"]);
		expect(moved).not.toBeNull();
		await h.drive(() =>
			h.site.post({
				kind: "position",
				snapshot: {
					site: "chesscom",
					gameId: h.site.gameId,
					fen: moved as string,
					ply: 2,
					sideToMove: "w",
					myColor: "w",
					clocks: { w: { ms: 280_000, running: true }, b: { ms: 290_000, running: false } },
					timeControl: { baseMs: 300_000, incMs: 2_000 },
					capturedAt: h.sim.now(),
				},
			})
		);
		expect(await h.until(() => session.recommendation()?.fen === moved, 10_000)).toBe(true);

		const fresh = session.recommendation();
		expect(fresh?.fen).toBe(moved as string);
		expect(fresh?.chosen.uci).not.toBe(stale?.chosen.uci);
		// The engine was asked about the new position.
		expect(h.transport.positions.at(-1)).toContain(moved as string);

		// The stale move is never dispatched: what eventually lands is the move for the new
		// position, and the adapter was never asked to observe the cancelled one.
		expect(await h.until(() => session.currentState() === "live:opponent-turn", 60_000)).toBe(true);
		expect(h.site.board.lastMove()?.uci).toBe(fresh?.chosen.uci ?? "");
		const observed = h.site.observeRequests().map((r) => `${r.from}${r.to}`);
		expect(observed).not.toContain(`${stale?.chosen.from}${stale?.chosen.to}`);
		expect(observed).toContain(`${fresh?.chosen.from}${fresh?.chosen.to}`);
	});

	it("ignores a replayed position (the reconnect sends `hello` + the last position + the outbox)", async () => {
		h = await createGameHarness();
		const session = h.session();
		await h.arrive();
		expect(await h.until(() => session.recommendation() !== null, 10_000)).toBe(true);
		const searches = h.transport.goLines.length;
		const rec = session.recommendation();

		// Task 21's `FeedPort` replays `hello` and the last `position` on every reconnect, and the
		// outbox may hold a copy of the very same message.
		await h.drive(() => h.site.hello());
		await h.arrive();
		await h.arrive();
		await h.advance(200);

		expect(h.transport.goLines.length).toBe(searches);
		expect(session.recommendation()).toBe(rec);
	});

	it("ignores a position for an older ply of the same game", async () => {
		h = await createGameHarness();
		const session = h.session();
		const start = h.site.board.fen();
		const moved = applyMoves(start, ["e2e4", "e7e5"]) as string;
		await h.drive(() =>
			h.site.post({
				kind: "position",
				snapshot: {
					site: "chesscom",
					gameId: h.site.gameId,
					fen: moved,
					ply: 2,
					sideToMove: "w",
					myColor: "w",
					clocks: { w: { ms: 280_000, running: true }, b: { ms: 290_000, running: false } },
					capturedAt: h.sim.now(),
				},
			})
		);
		expect(await h.until(() => session.recommendation()?.fen === moved, 10_000)).toBe(true);
		const searches = h.transport.goLines.length;

		// Browsing back / a stale outbox copy: ply 0 of the same game.
		await h.drive(() =>
			h.site.post({
				kind: "position",
				snapshot: {
					site: "chesscom",
					gameId: h.site.gameId,
					fen: start,
					ply: 0,
					sideToMove: "w",
					myColor: "w",
					clocks: { w: { ms: 300_000, running: true }, b: { ms: 300_000, running: false } },
					capturedAt: h.sim.now(),
				},
			})
		);
		await h.advance(200);
		expect(h.transport.goLines.length).toBe(searches);
		expect(session.recommendation()?.fen).toBe(moved);
	});
});
