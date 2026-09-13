// test/behavioral/game/rematch-titled.test.ts — 2026-09-13: after a game against a titled
// opponent the auto-queue offers one rematch (or accepts theirs) through the virtual hand before
// it queues a regular game. The whole stack on the simulator: the site's post-game controls
// (`rematchControls`), the opponent read with its title, the queue delay, the rematch press, the
// 15 s wait, the withdrawal and fall-through, the incoming panel, the once-only mark, the
// setting, and the break that waits for the rematch game.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { REMATCH } from "@core/constants/rematch";
import { TIMINGS } from "@core/constants/timings";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { createGameHarness, type GameHarness, type GameHarnessOptions } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const [MIN_DELAY, MAX_DELAY] = TIMINGS.autoQueueDelayRangeMs as unknown as [number, number];
const CONTROLS = SIM_TELEMETRY.rematchControls;

const clicksOf = (action: string) => h.site.rematchClicks().filter((c) => c.action === action);
const presses = () =>
	h.sim.debugger
		.commandsFor(CDP.inputDispatchMouseEvent)
		.filter((c) => (c.params as { type: string }).type === "mousePressed");
const inside = (
	p: { x: number; y: number },
	r: { x: number; y: number; width: number; height: number }
): boolean => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

const TITLED = { isBot: false, name: "fm_player", ratingEstimate: 2300, title: "FM" };
const UNTITLED = { isBot: false, name: "club_player", ratingEstimate: 1500 };

async function boot(
	opponent: { isBot: boolean; name: string; ratingEstimate: number | null; title?: string },
	options: GameHarnessOptions = {}
): Promise<void> {
	h = await createGameHarness({
		settings: { automation: { autoQueue: true } },
		rematchControls: true,
		...options,
	});
	await h.drive(() => h.site.opponent(opponent));
	await h.arrive();
}

describe("rematching titled players (2026-09-13)", () => {
	it("titled opponent: one Rematch press through the hand after the delay; the next game starting within 15 s means no new-game click", async () => {
		await boot(TITLED);
		const endedAt = h.sim.now();
		await h.drive(() => h.site.endGame("1-0"));
		expect(h.session().view().autoQueue?.status).toBe("waiting");
		await h.advance(MIN_DELAY - 1);
		expect(h.site.rematchClicks()).toEqual([]);
		expect(await h.until(() => clicksOf("rematch").length === 1, MAX_DELAY + 5_000)).toBe(true);
		const click = clicksOf("rematch")[0];
		expect(click && inside(click, CONTROLS.rematch)).toBe(true);
		expect(click && click.at - endedAt).toBeGreaterThanOrEqual(MIN_DELAY);
		// The press was the hand's: a real approach, one press, one release, the mirror moving.
		await h.advance(100);
		const mouse = h.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent);
		expect(mouse.filter((c) => c.params?.type === "mouseMoved").length).toBeGreaterThan(10);
		expect(presses()).toHaveLength(1);
		expect(h.commands().filter((c) => c.kind === "cursorTo").length).toBeGreaterThan(10);
		// Waiting for the answer: the panel's status, counting down to the ordinary click.
		const queue = h.session().view().autoQueue;
		expect(queue?.status).toBe("rematch");
		expect(queue && queue.dueAt - h.sim.now()).toBeLessThanOrEqual(REMATCH.acceptTimeoutMs);
		expect(clicksOf("new-game")).toHaveLength(0);
		// The opponent accepts: the rematch game starts.
		await h.advance(4_000);
		await h.drive(() => h.site.startGame({ gameId: "rematch-game" }));
		expect(h.session().view().gameId).toBe("rematch-game");
		expect(h.session().view().autoQueue).toBeUndefined();
		await h.advance(REMATCH.acceptTimeoutMs + MAX_DELAY);
		expect(clicksOf("new-game")).toHaveLength(0);
		expect(clicksOf("cancel")).toHaveLength(0);
		expect(h.site.rematchClicks()).toHaveLength(1);
		expect(h.sim.input.pointer(h.tabId)?.buttons).toBe(0);
	});

	it("offer not taken: Cancel is pressed at 15 s and the new-game click follows at once", async () => {
		await boot(TITLED, { rematchCancel: true });
		await h.drive(() => h.site.endGame("0-1"));
		expect(await h.until(() => clicksOf("rematch").length === 1, MAX_DELAY + 5_000)).toBe(true);
		const offeredAt = h.sim.now();
		await h.advance(REMATCH.acceptTimeoutMs - 1_500);
		expect(clicksOf("cancel")).toHaveLength(0);
		expect(clicksOf("new-game")).toHaveLength(0);
		expect(await h.until(() => clicksOf("cancel").length === 1, 10_000)).toBe(true);
		const cancel = clicksOf("cancel")[0];
		expect(cancel && inside(cancel, CONTROLS.cancel)).toBe(true);
		expect(cancel && cancel.at - offeredAt).toBeGreaterThanOrEqual(REMATCH.acceptTimeoutMs);
		// No second queue delay: the ordinary click follows the withdrawal directly.
		expect(await h.until(() => clicksOf("new-game").length === 1, 5_000)).toBe(true);
		const newGame = clicksOf("new-game")[0];
		expect(newGame && inside(newGame, CONTROLS.newGame)).toBe(true);
		expect(newGame && cancel && newGame.at - cancel.at).toBeLessThan(MIN_DELAY + 3_000);
		expect(["searching", "retrying", "waiting"]).toContain(
			h.session().view().autoQueue?.status ?? "none"
		);
	});

	it("no Cancel control on the page: the new-game click still follows the deadline", async () => {
		await boot(TITLED);
		await h.drive(() => h.site.endGame("1/2-1/2"));
		expect(await h.until(() => clicksOf("rematch").length === 1, MAX_DELAY + 5_000)).toBe(true);
		expect(
			await h.until(() => clicksOf("new-game").length === 1, REMATCH.acceptTimeoutMs + 8_000)
		).toBe(true);
		expect(clicksOf("cancel")).toHaveLength(0);
	});

	it("incoming offer from a titled opponent: Accept is pressed, nothing else", async () => {
		await boot(TITLED);
		await h.drive(() => {
			h.site.endGame("1-0");
			h.site.showIncomingRematch();
		});
		expect(await h.until(() => clicksOf("accept").length === 1, MAX_DELAY + 5_000)).toBe(true);
		const accept = clicksOf("accept")[0];
		expect(accept && inside(accept, CONTROLS.accept)).toBe(true);
		expect(clicksOf("rematch")).toHaveLength(0);
		expect(clicksOf("decline")).toHaveLength(0);
		await h.drive(() => h.site.startGame({ gameId: "their-rematch" }));
		await h.advance(REMATCH.acceptTimeoutMs + MAX_DELAY);
		expect(clicksOf("new-game")).toHaveLength(0);
		expect(h.site.rematchClicks()).toHaveLength(1);
	});

	it("their offer arriving during the queue delay is accepted before the delay would have ended", async () => {
		await boot(TITLED);
		await h.drive(() => h.site.endGame("1-0"));
		await h.advance(REMATCH.incomingPollMs - 200);
		await h.drive(() => h.site.showIncomingRematch());
		expect(await h.until(() => clicksOf("accept").length === 1, MAX_DELAY + 5_000)).toBe(true);
		expect(clicksOf("rematch")).toHaveLength(0);
	});

	it("their offer arriving while ours is pending is accepted", async () => {
		await boot(TITLED, { rematchCancel: true });
		await h.drive(() => h.site.endGame("1-0"));
		expect(await h.until(() => clicksOf("rematch").length === 1, MAX_DELAY + 5_000)).toBe(true);
		await h.advance(3_000);
		await h.drive(() => h.site.showIncomingRematch());
		expect(await h.until(() => clicksOf("accept").length === 1, 5_000)).toBe(true);
		await h.drive(() => h.site.startGame({ gameId: "simultaneous" }));
		await h.advance(REMATCH.acceptTimeoutMs + MAX_DELAY);
		expect(clicksOf("cancel")).toHaveLength(0);
		expect(clicksOf("new-game")).toHaveLength(0);
	});

	it("incoming offer from an untitled opponent is ignored: the queue retries the new-game control as usual", async () => {
		await boot(UNTITLED);
		await h.drive(() => {
			h.site.endGame("1-0");
			h.site.showIncomingRematch();
		});
		await h.advance(MAX_DELAY + TIMINGS.autoQueueRetryMs * 3);
		expect(clicksOf("accept")).toHaveLength(0);
		expect(clicksOf("rematch")).toHaveLength(0);
		expect(h.commands().filter((c) => c.kind === "rematch")).toHaveLength(0);
		// The panel hides the new-game button: the ordinary queue keeps retrying its read.
		expect(h.commands().filter((c) => c.kind === "startNewGame").length).toBeGreaterThan(0);
		expect(h.session().view().autoQueue?.status).toBe("retrying");
		await h.drive(() => h.site.hideIncomingRematch());
		expect(await h.until(() => clicksOf("new-game").length === 1, 20_000)).toBe(true);
	});

	it("untitled opponent: no rematch, the new-game click as before", async () => {
		await boot(UNTITLED);
		await h.drive(() => h.site.endGame("1-0"));
		expect(await h.until(() => clicksOf("new-game").length === 1, MAX_DELAY + 5_000)).toBe(true);
		expect(clicksOf("rematch")).toHaveLength(0);
		expect(h.commands().filter((c) => c.kind === "rematch")).toHaveLength(0);
	});

	it("a second game against the same titled opponent gets no rematch offer", async () => {
		await boot(TITLED);
		await h.drive(() => h.site.endGame("1-0"));
		expect(await h.until(() => clicksOf("rematch").length === 1, MAX_DELAY + 5_000)).toBe(true);
		// The rematch game (the site's positions keep the harness's own id, so none is posted here).
		await h.drive(() => h.site.startGame({ gameId: "rematch-game" }));
		await h.drive(() => h.site.opponent(TITLED));
		await h.advance(30_000);
		const readsBefore = rematchReads();
		await h.drive(() => h.site.endGame("0-1"));
		expect(await h.until(() => clicksOf("new-game").length === 1, MAX_DELAY + 5_000)).toBe(true);
		expect(clicksOf("rematch")).toHaveLength(1);
		// Not even a read: the once-only mark decides before the page is asked anything.
		expect(rematchReads()).toBe(readsBefore);
	});

	it("setting off: no rematch, the new-game click as before", async () => {
		await boot(TITLED, { settings: { automation: { autoQueue: true, rematchTitled: false } } });
		await h.drive(() => h.site.endGame("1-0"));
		expect(await h.until(() => clicksOf("new-game").length === 1, MAX_DELAY + 5_000)).toBe(true);
		expect(clicksOf("rematch")).toHaveLength(0);
		expect(h.commands().filter((c) => c.kind === "rematch")).toHaveLength(0);
	});

	it("a due session break waits for the rematch game and starts after it", async () => {
		await boot(TITLED, {
			settings: {
				automation: {
					autoMove: true,
					autoQueue: true,
					autoQueueSessionMinMinutes: 1,
					autoQueueSessionMaxMinutes: 1,
					autoQueueBreakMinMinutes: 1,
					autoQueueBreakMaxMinutes: 1,
				},
			},
		});
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		await h.advance(60_000);
		await h.drive(() => h.site.endGame("1-0"));
		// The break was due, but the rematch step runs first — and the hand stays armed for it.
		expect(h.session().view().autoQueue?.status).toBe("waiting");
		expect(h.executor()?.isArmed()).toBe(true);
		expect(await h.until(() => clicksOf("rematch").length === 1, MAX_DELAY + 5_000)).toBe(true);
		await h.drive(() => h.site.startGame({ gameId: "rematch-game" }));
		await h.drive(() => h.site.opponent(TITLED));
		expect(h.executor()?.isArmed()).toBe(true);
		await h.advance(5_000);
		expect(clicksOf("new-game")).toHaveLength(0);
		const endedAt = h.sim.now();
		await h.drive(() => h.site.endGame("0-1"));
		const queue = h.session().view().autoQueue;
		expect(queue?.status).toBe("break");
		expect(queue?.dueAt).toBe(endedAt + 60_000);
		expect(h.executor()?.isArmed()).toBe(false);
		await h.advance(59_999);
		expect(clicksOf("new-game")).toHaveLength(0);
		expect(await h.until(() => clicksOf("new-game").length === 1, 5_000)).toBe(true);
	});

	it("a due session break starts after an offer nobody took, and the mouse is released for it", async () => {
		await boot(TITLED, {
			settings: {
				automation: {
					autoMove: true,
					autoQueue: true,
					autoQueueSessionMinMinutes: 1,
					autoQueueSessionMaxMinutes: 1,
					autoQueueBreakMinMinutes: 1,
					autoQueueBreakMaxMinutes: 1,
				},
			},
		});
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		await h.advance(60_000);
		await h.drive(() => h.site.endGame("1-0"));
		expect(await h.until(() => clicksOf("rematch").length === 1, MAX_DELAY + 5_000)).toBe(true);
		expect(
			await h.until(
				() => h.session().view().autoQueue?.status === "break",
				REMATCH.acceptTimeoutMs + 5_000
			)
		).toBe(true);
		expect(h.executor()?.isArmed()).toBe(false);
		expect(clicksOf("new-game")).toHaveLength(0);
		const dueAt = h.session().view().autoQueue?.dueAt ?? 0;
		expect(dueAt - h.sim.now()).toBeGreaterThan(30_000);
		await h.advance(dueAt - h.sim.now() - 1);
		expect(clicksOf("new-game")).toHaveLength(0);
		expect(await h.until(() => clicksOf("new-game").length === 1, 5_000)).toBe(true);
	});
});

/** Every `rematch` port command the service worker sent so far — reads and revalidations alike. */
function rematchReads(): number {
	return h.commands().filter((c) => c.kind === "rematch").length;
}
