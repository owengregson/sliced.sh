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
		// A click is not confirmation: stop only after the site's next game arrives.
		await h.drive(() => h.site.startGame({ gameId: "second-game" }));
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

it("retries an unanswered request until a new game arrives", async () => {
	h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
	await h.arrive();
	await h.drive(() => h.site.endGame("1-0"));
	expect(await h.until(() => newGameCommands() >= 3, 20_000)).toBe(true);
	expect(h.session().view().autoQueue?.status).toBe("retrying");
	await h.drive(() => h.site.startGame({ gameId: "recovered" }));
	const count = newGameCommands();
	await h.advance(30_000);
	expect(newGameCommands()).toBe(count);
	expect(h.session().view().autoQueue).toBeUndefined();
});

it("waits one minute when the optional maximum is one, then starts", async () => {
	h = await createGameHarness({
		settings: {
			automation: { autoQueue: true, autoQueueDelayEnabled: true, autoQueueDelayMaxMinutes: 1 },
		},
	});
	await h.arrive();
	const now = h.sim.now();
	await h.drive(() => h.site.endGame("1-0"));
	expect(h.session().view().autoQueue?.dueAt).toBe(now + 60_000);
	await h.advance(59_999);
	expect(newGameCommands()).toBe(0);
	await h.advance(1);
	expect(newGameCommands()).toBe(1);
});

it("turning auto queue off cancels an already scheduled wait", async () => {
	h = await createGameHarness({
		settings: {
			automation: { autoQueue: true, autoQueueDelayEnabled: true, autoQueueDelayMaxMinutes: 1 },
		},
	});
	await h.arrive();
	await h.drive(() => h.site.endGame("1-0"));
	await h.patch({ automation: { autoQueue: false } });
	await h.advance(65_000);
	expect(newGameCommands()).toBe(0);
	expect(h.session().view().autoQueue).toBeUndefined();
});

it("a new game racing game-end persistence cancels the old request", async () => {
	h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
	await h.arrive();
	await h.drive(() => {
		h.site.endGame("1-0");
		h.site.startGame({ gameId: "immediate-next" });
	});
	await h.advance(10_000);
	expect(newGameCommands()).toBe(0);
	expect(h.session().view().autoQueue).toBeUndefined();
});

it("duplicate end events do not resample the wait or count a game twice", async () => {
	h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
	await h.arrive();
	await h.drive(() => h.site.endGame("1-0"));
	const dueAt = h.session().view().autoQueue?.dueAt;
	await h.advance(500);
	await h.drive(() => h.site.endGame("1-0"));
	expect(h.session().view().autoQueue?.dueAt).toBe(dueAt);
	const stats = await h.sw.run(() => chromeLocalGet(LOCAL_KEYS.sessionStats));
	expect(stats?.games).toBe(1);
});

it("a stale finished-game replay cannot end the next game", async () => {
	h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
	await h.arrive();
	await h.drive(() => h.site.startGame({ gameId: "new-game" }));
	await h.drive(() => h.site.post({ kind: "gameEnded", gameId: "old-game", result: "1-0" }));
	expect(h.session().currentState()).toBe("live:opponent-turn");
	await h.advance(10_000);
	expect(newGameCommands()).toBe(0);
});

it("a handled game-end replay restores state without reviving a cancelled queue", async () => {
	h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
	await h.arrive();
	await h.drive(() => h.site.post({ kind: "gameEnded", result: "1-0", replayed: true }));
	expect(h.session().currentState()).toBe("game-over");
	await h.advance(10_000);
	expect(newGameCommands()).toBe(0);
	expect((await h.sw.run(() => chromeLocalGet(LOCAL_KEYS.sessionStats)))?.games ?? 0).toBe(0);
});

it("a same-site matchmaking navigation preserves the scheduled deadline", async () => {
	h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
	await h.arrive();
	await h.drive(() => h.site.endGame("1-0"));
	const dueAt = h.session().view().autoQueue?.dueAt;
	await h.sw.run(() =>
		h.sim.chrome.tabs.update(h.tabId, { url: "https://www.chess.com/play/online" })
	);
	expect(h.session().view().autoQueue?.dueAt).toBe(dueAt);
	expect(await h.until(() => newGameCommands() > 0, MAX_DELAY + 100)).toBe(true);
});

it("navigation outside the site cancels the queued game", async () => {
	h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
	await h.arrive();
	await h.drive(() => h.site.endGame("1-0"));
	await h.sw.run(() => h.sim.chrome.tabs.update(h.tabId, { url: "https://example.com/" }));
	await h.advance(10_000);
	expect(newGameCommands()).toBe(0);
	expect(h.session().view().autoQueue).toBeUndefined();
});

it("leaving the game for same-site analysis cancels the queued game", async () => {
	h = await createGameHarness({ settings: { automation: { autoQueue: true } } });
	await h.arrive();
	await h.drive(() => h.site.endGame("1-0"));
	await h.sw.run(() => h.sim.chrome.tabs.update(h.tabId, { url: "https://www.chess.com/analysis" }));
	await h.advance(10_000);
	expect(newGameCommands()).toBe(0);
	expect(h.session().view().autoQueue).toBeUndefined();
});
