// test/behavioral/game/game-over-autoqueue.test.ts — Task 30 Step 2 (d): `gameEnded` takes the
// session to `game-over`, folds the §13.6 session stats, and — with `automation.autoQueue` on —
// asks the page for a new game after a delay inside `TIMINGS.autoQueueDelayRangeMs`. Nothing here
// opens a tab, a window or a notification (§13.4).
import { afterEach, describe, expect, it } from "bun:test";
import { chromeLocalGet } from "@core/chrome/storage";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TIMINGS } from "@core/constants/timings";
import type { SessionStats } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const [MIN_DELAY, MAX_DELAY] = TIMINGS.autoQueueDelayRangeMs as unknown as [number, number];

const newGameCommands = (): number => h.commands().filter((c) => c.kind === "startNewGame").length;

describe("game session: game over and the auto-queue (Step 2d)", () => {
	it("asks for a new game after a delay in TIMINGS.autoQueueDelayRangeMs when auto-queue is on", async () => {
		h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);

		const endedAt = h.sim.now();
		await h.drive(() => h.site.endGame("1-0"));
		expect(h.session().currentState()).toBe("game-over");
		expect(newGameCommands()).toBe(0);

		// Nothing before the range's lower bound …
		await h.advance(MIN_DELAY - 1);
		expect(newGameCommands()).toBe(0);
		// … and exactly one request by its upper bound.
		expect(await h.until(() => newGameCommands() > 0, MAX_DELAY + 100)).toBe(true);
		const at = h.sim.now();
		expect(at - endedAt).toBeGreaterThanOrEqual(MIN_DELAY);
		expect(at - endedAt).toBeLessThanOrEqual(MAX_DELAY + 100);
		await h.advance(MAX_DELAY * 2);
		expect(newGameCommands()).toBe(1);
	});

	it("does nothing when auto-queue is off", async () => {
		h = await createGameHarness();
		await h.arrive();
		await h.drive(() => h.site.endGame("0-1"));
		expect(h.session().currentState()).toBe("game-over");
		await h.advance(MAX_DELAY * 3);
		expect(newGameCommands()).toBe(0);
	});

	it("folds the finished game into the session stats (§13.6)", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await h.arrive();
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		const afterMove = await h.sw.run(
			() => chromeLocalGet(LOCAL_KEYS.sessionStats) as Promise<SessionStats | undefined>
		);
		expect(afterMove?.moves).toBe(1);
		expect(afterMove?.avgThinkMs).toBeGreaterThan(0);
		expect(typeof afterMove?.top1Pct).toBe("number");
		expect(typeof afterMove?.acpl).toBe("number");

		await h.drive(() => h.site.endGame("1-0"));
		await h.advance(50);
		const afterGame = await h.sw.run(
			() => chromeLocalGet(LOCAL_KEYS.sessionStats) as Promise<SessionStats | undefined>
		);
		expect(afterGame?.games).toBe(1);
		expect(typeof afterGame?.outOfBandStreak).toBe("number");
	});

	it("a new game on the same tab starts a fresh session state and cancels a pending queue", async () => {
		h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
		await h.arrive();
		await h.drive(() => h.site.endGame("1/2-1/2"));
		expect(h.session().currentState()).toBe("game-over");
		await h.drive(() => h.site.startGame({ gameId: "second-game" }));
		expect(h.session().currentState()).toBe("live:opponent-turn");
		expect(h.session().view().gameId).toBe("second-game");
	});
});
