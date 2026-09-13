import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { DEFAULT_KEYBINDS } from "@core/constants/defaults";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { OPPONENT_EXPLORATION, PATH } from "@core/motor/constants";
import { createGameHarness, type GameHarness } from "./harness";

const MAX_STEP_PX = TELEMETRY_BANDS.pointer.maxStepPx;

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const moves = () => h.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent);
const presses = () => moves().filter((command) => command.params?.type === "mousePressed");

/**
 * Advance until the hand presses. The budget is the plan's own think plus slack, never a magic
 * number: `opponentTurn` runs a 15+0 game so that the *opponent's* turn is long enough to explore
 * in, and a first move of a 15-minute game is planned at ~16 s — past any fixed 15 s wait, for
 * reasons that have nothing to do with what these tests are about.
 */
async function untilPressed(): Promise<boolean> {
	const thinkMs = h.session().recommendation()?.plan.thinkMs ?? 0;
	return h.until(() => presses().length > 0, thinkMs + 10_000);
}

async function opponentTurn(autoMove = true): Promise<void> {
	h = await createGameHarness({
		myColor: "b",
		seed: "opponent-bouts",
		sendKeybinds: true,
		timeControl: { baseMs: 900_000, incMs: 0 },
		settings: { automation: { autoMove }, display: { virtualCursor: true } },
		script: { holdPonder: true },
	});
	await h.arrive();
}

describe("opponent-turn free pointer exploration", () => {
	it("rests before its first exploration and cancels that rest as soon as our turn arrives", async () => {
		await opponentTurn();
		await h.advance(OPPONENT_EXPLORATION.initialRestMs[0] - 10);
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

	it("alternates spells of activity and stillness on a blitz clock, with no button, no teleport and no point above the viewport origin", async () => {
		// A seed whose 30 s draw no scramble hold (`SCRAMBLE_HOLD.regularProb` has no settings gate)
		// and no no-ponder turn; `attention-plan-4` below is the seed that draws the latter.
		h = await createGameHarness({
			myColor: "b",
			seed: "attention-plan-2",
			sendKeybinds: true,
			timeControl: { baseMs: 180_000, incMs: 0 },
			settings: { automation: { autoMove: true }, display: { virtualCursor: true } },
			script: { holdPonder: true },
		});
		await h.arrive();
		expect(await h.until(() => moves().length > 5, 3000)).toBe(true);
		const t0 = moves()[0]?.at ?? 0;
		await h.advance(30_000);
		const events = moves();
		expect(presses()).toHaveLength(0);
		expect(events.every((command) => command.params?.buttons === 0)).toBe(true);
		expect(
			events.every((command) => Number(command.params?.x) >= 0 && Number(command.params?.y) >= 0)
		).toBe(true);
		let prev: { x: number; y: number } | null = null;
		for (const command of events) {
			const p = { x: Number(command.params?.x), y: Number(command.params?.y) };
			if (prev) expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThanOrEqual(MAX_STEP_PX);
			prev = p;
		}
		// one-second bins: a blitz still is 0.8–2.2 s of stillness (at most a tremor point), an
		// active spell 1.2–3 s of movement — both must show up, and stillness must run for more
		// than a bin at a time.
		const bins = new Array<number>(30).fill(0);
		for (const command of events) {
			const bin = Math.floor((command.at - t0) / 1000);
			if (bin >= 0 && bin < bins.length) bins[bin] = (bins[bin] ?? 0) + 1;
		}
		const quiet = bins.map((n) => n <= 1);
		expect(bins.filter((n) => n > 10).length).toBeGreaterThanOrEqual(4);
		expect(quiet.filter(Boolean).length).toBeGreaterThanOrEqual(4);
		expect(quiet.some((q, i) => q && quiet[i + 1] === true)).toBe(true);
		expect(h.session().currentState()).toBe("live:opponent-turn");
		expect(h.executor()?.isExploring()).toBe(true);
	});

	it("gives some opponent turns no pondering at all: the hand keeps still where the drop left it, and our turn still cancels at once", async () => {
		// `decideOpponentTurn` draws a no-ponder turn for this seed on a blitz clock
		// (`OPPONENT_EXPLORATION.attention.blitz.noPonderProb`): the exploration task runs, but its
		// spells are stills — nothing reaches the page for the whole think.
		h = await createGameHarness({
			myColor: "b",
			seed: "attention-plan-4",
			sendKeybinds: true,
			timeControl: { baseMs: 180_000, incMs: 0 },
			settings: { automation: { autoMove: true }, display: { virtualCursor: true } },
			script: { holdPonder: true },
		});
		await h.arrive();
		await h.advance(30_000);
		// nothing but the resting hand's idle tremor: a few points, each a few px from the last
		expect(moves().length).toBeLessThanOrEqual(8);
		expect(moves().every((command) => command.params?.buttons === 0)).toBe(true);
		let prev: { x: number; y: number } | null = null;
		for (const command of moves()) {
			const p = { x: Number(command.params?.x), y: Number(command.params?.y) };
			if (prev)
				expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThanOrEqual(PATH.idle.maxOffsetPx);
			prev = p;
		}
		expect(h.executor()?.isExploring()).toBe(true);
		expect(h.session().currentState()).toBe("live:opponent-turn");
		await h.arrive("e2e4");
		expect(h.executor()?.isExploring()).toBe(false);
		expect(await untilPressed()).toBe(true);
	});

	it("cancels free movement before the own-turn move and resumes only on the next opponent turn", async () => {
		await opponentTurn();
		expect(await h.until(() => moves().length > 10, 3000)).toBe(true);
		await h.arrive("e2e4");
		expect(h.executor()?.isExploring()).toBe(false);
		expect(await untilPressed()).toBe(true);
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
