import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { DEFAULT_KEYBINDS } from "@core/constants/defaults";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const moves = () => h.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent);
const presses = () => moves().filter((command) => command.params?.type === "mousePressed");

async function opponentTurn(autoMove = true): Promise<void> {
	h = await createGameHarness({
		myColor: "b",
		seed: "opponent-bouts",
		sendKeybinds: true,
		timeControl: { baseMs: 900_000, incMs: 0 },
		settings: { automation: { autoMove }, display: { virtualCursor: true } },
	});
	await h.arrive();
}

describe("opponent-turn free pointer exploration", () => {
	it("rests before its first exploration and cancels that rest as soon as our turn arrives", async () => {
		await opponentTurn();
		await h.advance(900);
		expect(moves()).toHaveLength(0);
		expect(h.executor()?.isExploring()).toBe(true);
		await h.arrive("e2e4");
		expect(h.executor()?.isExploring()).toBe(false);
		expect(presses()).toHaveLength(0);
	});
	it("keeps exploring both sides over multiple bouts without a selection or execution transition", async () => {
		await opponentTurn();
		expect(await h.until(() => moves().length > 20, 3000)).toBe(true);
		const first = moves().length;
		await h.advance(20_000);
		expect(moves().length).toBeGreaterThan(first + 100);
		expect(presses()).toHaveLength(0);
		expect(moves().every((command) => command.params?.buttons === 0)).toBe(true);
		expect(h.session().currentState()).toBe("live:opponent-turn");
		expect(h.executor()?.isRunning()).toBe(false);
		expect(h.executor()?.isExploring()).toBe(true);
		const squares = moves()
			.map((command) =>
				h.site.board.squareOf(
					h.site.dom.elementAt(
						Number(command.params?.x),
						Number(command.params?.y)
					) as EventTarget | null
				)
			)
			.filter((square) => square !== null);
		expect(squares.some((square) => /[12]$/.test(square))).toBe(true);
		expect(squares.some((square) => /[78]$/.test(square))).toBe(true);
		await h.drive(() =>
			h.transport.feed("info depth 12 multipv 1 score cp 42 nodes 100 time 10 pv e2e4 e7e5")
		);
		await h.advance(250);
		expect(h.session().view().evaluation).toEqual({ fen: h.site.board.fen(), eval: { cp: 42 } });
	});

	it("waits for arming and stops promptly on disarm and disable", async () => {
		await opponentTurn(false);
		await h.advance(3000);
		expect(moves()).toHaveLength(0);
		await h.pressKey(DEFAULT_KEYBINDS.toggleAutoMove);
		expect(await h.until(() => moves().length > 5, 3000)).toBe(true);
		await h.pressKey(DEFAULT_KEYBINDS.toggleAutoMove);
		await h.advance(100);
		const stopped = moves().length;
		await h.advance(5000);
		expect(moves()).toHaveLength(stopped);
		expect(h.executor()?.isExploring()).toBe(false);
		await h.pressKey(DEFAULT_KEYBINDS.toggleAutoMove);
		expect(await h.until(() => moves().length > stopped + 5, 3000)).toBe(true);
		await h.patch({ enabled: false });
		await h.advance(100);
		const disabled = moves().length;
		await h.advance(5000);
		expect(moves()).toHaveLength(disabled);
		expect(h.executor()?.isExploring()).toBe(false);
	});

	it("cancels immediately on navigation and disposal without a late pointer event", async () => {
		await opponentTurn();
		expect(await h.until(() => moves().length > 5, 3000)).toBe(true);
		const executor = h.executor()!;
		await h.drive(() => h.session().onTabEvent("navigated"));
		await h.advance(0);
		expect(executor.isExploring()).toBe(false);
		const stopped = moves().length;
		await h.advance(6000);
		expect(moves()).toHaveLength(stopped);
		await h.drive(() => h.session().dispose());
		await h.drive(() => executor.whenIdle());
		await h.advance(0);
		expect(moves()).toHaveLength(stopped);
		expect(h.sim.debugger.commandsFor(CDP.focusEmulation).at(-1)?.params?.enabled).toBe(false);
	});

	it("cancels free movement before the own-turn move and resumes only on the next opponent turn", async () => {
		await opponentTurn();
		expect(await h.until(() => moves().length > 10, 3000)).toBe(true);
		await h.arrive("e2e4");
		expect(h.executor()?.isExploring()).toBe(false);
		expect(await h.until(() => presses().length > 0, 15_000)).toBe(true);
		expect(await h.until(() => !h.executor()?.isRunning(), 5000)).toBe(true);
		expect(presses()).toHaveLength(1);
		const commands = moves();
		const pressIndex = commands.findIndex((command) => command.params?.type === "mousePressed");
		const releaseIndex = commands.findIndex(
			(command, i) => i > pressIndex && command.params?.type === "mouseReleased"
		);
		expect(releaseIndex).toBeGreaterThan(pressIndex);
		for (const command of commands.slice(pressIndex + 1, releaseIndex)) {
			expect(command.params?.buttons).toBe(1);
		}
		await h.arrive();
		const afterMove = moves().length;
		expect(await h.until(() => moves().length > afterMove + 10, 3000)).toBe(true);
		expect(presses()).toHaveLength(1);
	});
});
