// test/behavioral/game/break-unlock.test.ts — a session break releases the mouse (owner,
// 2026-09-13: "when taking a break we should unlock mouse"). Within a playing session the hand
// stays armed between games; when the auto-queue takes its break the hand is disarmed, the mirror
// is hidden, and the next game arms the hand again on its own.
import { afterEach, describe, expect, it } from "bun:test";
import type { GamePortCommand } from "@core/constants/messages";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const ownership = (): boolean[] =>
	h
		.commands()
		.filter(
			(c): c is Extract<GamePortCommand, { kind: "inputOwnership" }> => c.kind === "inputOwnership"
		)
		.map((c) => c.owned);
const hides = (): number => h.commands().filter((c) => c.kind === "cursorHide").length;

const BREAK_SETTINGS = {
	autoMove: true,
	autoQueue: true,
	autoQueueSessionMinMinutes: 1,
	autoQueueSessionMaxMinutes: 1,
	autoQueueBreakMinMinutes: 1,
	autoQueueBreakMaxMinutes: 1,
};

describe("game session: the session break releases the mouse", () => {
	it("disarms the hand and hides the mirror when the break starts, and re-arms for the next game", async () => {
		const target = {
			targetId: "queue-button",
			rect: { left: 950, top: 650, width: 180, height: 45 },
			viewport: { width: 1280, height: 800 },
		};
		h = await createGameHarness({
			settings: { automation: BREAK_SETTINGS },
			onCommand: (command) => {
				if (command.kind === "startNewGame")
					h.site.post({ kind: "startNewGameResult", id: command.id, status: "ready", target });
			},
		});
		h.site.dom.document.body.insertAdjacentHTML("beforeend", '<button id="queue">New Game</button>');
		h.site.dom.layout("#queue", { x: 950, y: 650, width: 180, height: 45 });
		h.site.dom.query("#queue").addEventListener("click", () => {
			h.site.startGame({ gameId: "after-the-break" });
		});
		await h.arrive();
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		await h.advance(60_000);
		const hidesBefore = hides();
		await h.drive(() => h.site.endGame("1-0"));
		expect(h.session().view().autoQueue?.status).toBe("break");
		// The break released the hand: ownership dropped, mirror hidden, hand not armed.
		expect(h.executor()?.isArmed()).toBe(false);
		expect(ownership().at(-1)).toBe(false);
		expect(hides()).toBeGreaterThan(hidesBefore);
		expect(h.sim.input.pointer(h.tabId)?.buttons ?? 0).toBe(0);
		// The break passes, the queue asks for a game, the site starts one: the hand arms again.
		expect(
			await h.until(() => h.session().view().gameId === "after-the-break", 60_000 + 30_000)
		).toBe(true);
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		expect(ownership().at(-1)).toBe(true);
	});

	it("keeps the hand armed across the short pause between games inside a session", async () => {
		h = await createGameHarness({
			settings: {
				automation: {
					...BREAK_SETTINGS,
					autoQueueSessionMinMinutes: 30,
					autoQueueSessionMaxMinutes: 30,
				},
			},
		});
		await h.arrive();
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		const hidesBefore = hides();
		await h.drive(() => h.site.endGame("1-0"));
		expect(h.session().view().autoQueue?.status).toBe("waiting");
		expect(h.executor()?.isArmed()).toBe(true);
		expect(hides()).toBe(hidesBefore);
	});

	it("an explicit disarm during the break is honoured: the next game does not re-arm", async () => {
		h = await createGameHarness({ settings: { automation: BREAK_SETTINGS } });
		await h.arrive();
		expect(await h.until(() => h.executor()?.isArmed() === true, 10_000)).toBe(true);
		await h.advance(60_000);
		await h.drive(() => h.site.endGame("1-0"));
		expect(h.session().view().autoQueue?.status).toBe("break");
		expect(h.executor()?.isArmed()).toBe(false);
		await h.drive(() => h.session().command("disarm"));
		await h.patch({ automation: { autoMove: false } });
		await h.drive(() => h.site.startGame({ gameId: "manual-after-break" }));
		await h.advance(500);
		expect(h.executor()?.isArmed()).toBe(false);
	});
});
