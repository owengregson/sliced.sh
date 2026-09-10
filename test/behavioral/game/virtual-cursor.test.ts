// test/behavioral/game/virtual-cursor.test.ts — Fix D, end to end on the simulator.
//
// The owner's request was "show a virtual mouse ... to display where the hand is currently located.
// it should always be updated", and the one property that makes it true rather than decorative is
// that the positions the page is shown are *exactly* the positions the page was told: the sequence
// the CDP backend dispatched, in order, nothing dropped and nothing invented. Between moves the
// mirror parks on the last dispatched point, because that is where the pointer actually is.
//
// The gates are the other half: a disarmed hand owns no pointer, a switched-off assistant acts on
// the page not at all, and `Settings.display.virtualCursor` off must post nothing whatsoever.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import type { GamePortCommand } from "@core/constants/messages";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

type CursorCmd = Extract<GamePortCommand, { kind: "cursorTo" } | { kind: "cursorHide" }>;

const mirror = (): CursorCmd[] =>
	h.commands().filter((c): c is CursorCmd => c.kind === "cursorTo" || c.kind === "cursorHide");

const positions = (): Array<[number, number, boolean]> =>
	mirror()
		.filter((c): c is Extract<CursorCmd, { kind: "cursorTo" }> => c.kind === "cursorTo")
		.map((c) => [c.x, c.y, c.down]);

/** What the hand actually told the page, in order: `Input.dispatchMouseEvent` x/y + button state. */
const dispatched = (): Array<[number, number, boolean]> =>
	h.sim.debugger.commands
		.filter((c) => c.method === CDP.inputDispatchMouseEvent)
		.map((c) => {
			const p = (c.params ?? {}) as { x: number; y: number; buttons: number };
			return [p.x, p.y, (p.buttons & CDP.mouse.leftButtons) !== 0] as [number, number, boolean];
		});

/** Arm the hand and let it play the move it is given. */
async function playOneMove(): Promise<void> {
	await h.sw.run(() => h.session().command("armAutoMove"));
	await h.arrive();
	expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
		true
	);
	expect(h.site.board.lastMove()?.byMe).toBe(true);
}

describe("game session: the pointer mirror follows what the hand dispatched", () => {
	it("posts exactly the dispatched sequence and parks on the last point", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();

		const sent = positions();
		expect(sent.length).toBeGreaterThan(8);
		// not a plan and not a sample: every point the page was told, in order
		expect(sent).toEqual(dispatched());
		// the press and release are reflected, so the mirror dips exactly while the piece is held
		expect(sent.some(([, , down]) => down)).toBe(true);
		expect(sent.at(-1)?.[2]).toBe(false);
		// it parks where the pointer is: the last post is the last dispatch, and nothing hid it
		expect(sent.at(-1)).toEqual(dispatched().at(-1));
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		// viewport CSS px, the same space the board rect is reported in
		const board = h.site.board.boardRect;
		const inside = sent.filter(
			([x, y]) =>
				x >= board.left &&
				x <= board.left + board.width &&
				y >= board.top &&
				y <= board.top + board.height
		);
		expect(inside.length).toBeGreaterThan(0);
	});

	it("hides the mirror when the hand is disarmed, and only once", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");

		await h.sw.run(() => h.session().command("disarm"));
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
		const hides = mirror().filter((c) => c.kind === "cursorHide").length;
		await h.sw.run(() => h.session().command("disarm"));
		expect(mirror().filter((c) => c.kind === "cursorHide").length).toBe(hides);
	});

	it("hides the mirror when the assistant is switched off (§4.4)", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		await h.patch({ enabled: false });
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
	});

	it("hides an already-drawn mirror the moment the setting goes off", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		const drawn = positions().length;
		expect(drawn).toBeGreaterThan(0);

		await h.patch({ display: { virtualCursor: false } });
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
		// and nothing of it comes back on the next move
		await h.arrive("e7e5");
		expect(await h.until(() => h.session().view().ply >= 2, 10_000)).toBe(true);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		expect(positions().length).toBe(drawn);
	});

	it("posts nothing at all while the setting is off, though the hand still plays", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: true }, display: { virtualCursor: false } },
		});
		await playOneMove();
		expect(dispatched().length).toBeGreaterThan(8);
		expect(mirror()).toEqual([]);
	});

	it("hides the mirror when the game ends", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		await h.drive(() => h.session().onGameEnded("1-0"));
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
	});

	it("hides the mirror when the tab navigates away", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await playOneMove();
		expect(mirror().at(-1)?.kind).toBe("cursorTo");
		await h.drive(() => h.session().onTabEvent("navigated"));
		expect(mirror().at(-1)?.kind).toBe("cursorHide");
	});
});
