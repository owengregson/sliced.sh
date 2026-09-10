// test/service/move-executor/cdp-mouse.test.ts — Step 1: CDP mouse semantics + absolute-time travel.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { debuggerAttach, debuggerSend } from "@core/chrome/debugger";
import { CDP } from "@core/constants";
import type { PathPoint } from "@core/motor/types";
import { defaultScheduler } from "@core/util/scheduler";
import { CdpMouse } from "@service/move-executor/cdp-mouse";
import { createSimulator, type Simulator } from "@test/sim";

const START = 1_000_000;
let sim: Simulator;
let tabId: number;
const prevChrome = (globalThis as Record<string, unknown>).chrome;

beforeEach(async () => {
	sim = createSimulator({ startAt: START });
	sim.time.install();
	tabId = sim.openTab("https://www.chess.com/game/174252022572").tabId;
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
	await debuggerAttach(tabId, CDP.protocolVersion);
});
afterEach(async () => {
	sim.time.uninstall();
	(globalThis as Record<string, unknown>).chrome = prevChrome;
	await sim.dispose();
});

const makeMouse = (start = { x: 10, y: 10 }) =>
	new CdpMouse((method, params) => debuggerSend(tabId, method, params), start, {
		now: sim.now,
		scheduler: defaultScheduler,
	});

const mouseCommands = (): Array<Record<string, unknown> & { at: number }> =>
	sim.debugger
		.commandsFor(CDP.inputDispatchMouseEvent)
		.map((c) => ({ ...(c.params as Record<string, unknown>), at: c.at }));

describe("CdpMouse", () => {
	it("dispatches the verified press / drag-move / release parameter shapes and never a timestamp", async () => {
		const mouse = makeMouse();
		await mouse.moveAt({ x: 450, y: 650 }, sim.now());
		await mouse.pressAt({ x: 450, y: 650 }, sim.now());
		await mouse.moveAt({ x: 450, y: 520 }, sim.now());
		await mouse.releaseAt({ x: 450, y: 450 }, sim.now());
		const cmds = mouseCommands();
		expect(cmds).toHaveLength(4);
		expect(cmds[0]).toMatchObject({ type: "mouseMoved", x: 450, y: 650, button: "none", buttons: 0 });
		expect(cmds[1]).toMatchObject({
			type: "mousePressed",
			x: 450,
			y: 650,
			button: "left",
			buttons: 1,
			clickCount: 1,
		});
		expect(cmds[2]).toMatchObject({ type: "mouseMoved", x: 450, y: 520, button: "left", buttons: 1 });
		expect(cmds[3]).toMatchObject({
			type: "mouseReleased",
			x: 450,
			y: 450,
			button: "left",
			buttons: 0,
			clickCount: 1,
		});
		for (const c of cmds) {
			expect("timestamp" in c).toBe(false);
			expect(c.modifiers).toBe(0);
		}
		expect(mouse.position).toEqual({ x: 450, y: 450 });
		expect(mouse.pressed).toBe(false);
		// the page saw a trusted-equivalent pointer sequence with buttons=1 during the drag
		const moves = sim.input.events.filter((e) => e.type === "pointermove");
		expect(moves.map((e) => e.buttons)).toEqual([0, 1]);
	});

	it("travel(path) dispatches each point at its cumulative dtMs on the virtual clock (±4 ms)", async () => {
		const mouse = makeMouse();
		const path: PathPoint[] = [
			{ x: 20, y: 20, dtMs: 8 },
			{ x: 30, y: 30, dtMs: 8 },
			{ x: 40, y: 40, dtMs: 12 },
			{ x: 50, y: 50, dtMs: 30 },
		];
		const done = mouse.travel(path);
		await sim.time.advance(100);
		await done;
		const ats = mouseCommands().map((c) => c.at - START);
		const expected = [8, 16, 28, 58];
		expect(ats).toHaveLength(4);
		for (let i = 0; i < expected.length; i++) {
			expect(Math.abs((ats[i] ?? 0) - (expected[i] ?? 0))).toBeLessThanOrEqual(4);
		}
		expect(mouse.position).toEqual({ x: 50, y: 50 });
	});

	it("resyncs the schedule after a renderer stall longer than stallResyncMs instead of catching up", async () => {
		let n = 0;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, () => {
			n += 1;
			if (n === 2) return new Promise((r) => setTimeout(() => r({}), CDP.stallResyncMs + 20));
			return {};
		});
		const mouse = makeMouse();
		const path: PathPoint[] = [
			{ x: 20, y: 20, dtMs: 10 },
			{ x: 30, y: 30, dtMs: 10 },
			{ x: 40, y: 40, dtMs: 10 },
		];
		const done = mouse.travel(path);
		await sim.time.advance(200);
		await done;
		const ats = mouseCommands().map((c) => c.at - START);
		// #2 dispatched at 20 and acked at 80 (> 40 ms late) → resync → #3 at 80 + 10, not at 80.
		expect(ats[0]).toBe(10);
		expect(ats[1]).toBe(20);
		expect(ats[2]).toBe(20 + CDP.stallResyncMs + 20 + 10);
	});

	it("a short stall (≤ stallResyncMs) is absorbed: later points keep the original schedule", async () => {
		let n = 0;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, () => {
			n += 1;
			if (n === 1) return new Promise((r) => setTimeout(() => r({}), 15));
			return {};
		});
		const mouse = makeMouse();
		const done = mouse.travel([
			{ x: 20, y: 20, dtMs: 10 },
			{ x: 30, y: 30, dtMs: 10 },
			{ x: 40, y: 40, dtMs: 10 },
		]);
		await sim.time.advance(200);
		await done;
		expect(mouseCommands().map((c) => c.at - START)).toEqual([10, 25, 30]);
	});

	it("a rejected press leaves the button state up (the renderer never acknowledged it)", async () => {
		sim.debugger.respond(CDP.inputDispatchMouseEvent, async (params) => {
			if ((params as { type: string }).type === "mousePressed") throw new Error("Target closed");
			return {};
		});
		const mouse = makeMouse();
		await expect(mouse.pressAt({ x: 20, y: 20 }, sim.now())).rejects.toThrow("Target closed");
		expect(mouse.pressed).toBe(false);
		await mouse.moveAt({ x: 21, y: 21 }, sim.now());
		expect(mouseCommands().at(-1)).toMatchObject({ type: "mouseMoved", button: "none", buttons: 0 });
	});

	it("travel stops at an abort and leaves the button state untouched", async () => {
		const mouse = makeMouse();
		const ac = new AbortController();
		const done = mouse.travel(
			[
				{ x: 20, y: 20, dtMs: 10 },
				{ x: 30, y: 30, dtMs: 10 },
				{ x: 40, y: 40, dtMs: 10 },
			],
			ac.signal
		);
		const outcome = done.then(
			() => "resolved",
			(e: Error) => e.message
		);
		await sim.time.advance(12);
		ac.abort();
		await sim.time.advance(50);
		expect(await outcome).toBe("aborted");
		expect(mouseCommands()).toHaveLength(1);
	});
});
