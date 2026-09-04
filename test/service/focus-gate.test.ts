// test/service/focus-gate.test.ts — §13.4 focus discipline.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { GamePortMessage } from "@core/constants";
import { FocusGate } from "@service/focus-gate";
import { createSimulator, type Simulator } from "@test/sim";
import { fakeLink } from "./fakes";

let sim: Simulator;
let tabId: number;
let other: number;
const prevChrome = (globalThis as Record<string, unknown>).chrome;
let link: ReturnType<typeof fakeLink>;
let gate: FocusGate;

const focus = (id: number, hasFocus: boolean, visibility: "visible" | "hidden" = "visible") =>
	link.emit(id, { kind: "focus", hasFocus, visibility, at: sim.now() } satisfies GamePortMessage);

beforeEach(() => {
	sim = createSimulator({ startAt: 1_000_000 });
	tabId = sim.openTab("https://www.chess.com/game/live/1").tabId;
	other = sim.openTab("https://lichess.org/", { active: false }).tabId;
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
	link = fakeLink({ [tabId]: 1, [other]: 1 });
	gate = new FocusGate(link);
});
afterEach(async () => {
	gate.dispose();
	(globalThis as Record<string, unknown>).chrome = prevChrome;
	await sim.dispose();
});

describe("FocusGate.canExecute", () => {
	it("requires a focus report: unknown tabs and unfocused pages are 'unfocused'", () => {
		expect(gate.canExecute(tabId)).toEqual({ ok: false, reason: "unfocused" });
		focus(tabId, false);
		gate.positionArrived(tabId, sim.now());
		expect(gate.canExecute(tabId)).toEqual({ ok: false, reason: "unfocused" });
		focus(tabId, true);
		gate.positionArrived(tabId, sim.now());
		expect(gate.canExecute(tabId)).toEqual({ ok: true });
	});

	it("a blur edge inside the move window is 'blur-in-window' until the next position arrives", () => {
		focus(tabId, true);
		gate.positionArrived(tabId, sim.now());
		expect(gate.canExecute(tabId).ok).toBe(true);
		focus(tabId, false);
		focus(tabId, true); // focus came back, but the edge happened inside the window
		expect(gate.canExecute(tabId)).toEqual({ ok: false, reason: "blur-in-window" });
		expect(gate.snapshot(tabId)).toEqual({ pageHasFocus: true, blurSeenThisMove: true });
		gate.positionArrived(tabId, sim.now());
		expect(gate.canExecute(tabId)).toEqual({ ok: true });
		expect(gate.snapshot(tabId)).toEqual({ pageHasFocus: true, blurSeenThisMove: false });
	});

	it("a blur before the position arrived does not count, and focus must be true right now", () => {
		focus(tabId, true);
		focus(tabId, false);
		focus(tabId, true);
		gate.positionArrived(tabId, sim.now());
		expect(gate.canExecute(tabId).ok).toBe(true);
		focus(tabId, false);
		expect(gate.canExecute(tabId)).toEqual({ ok: false, reason: "unfocused" });
		expect(gate.snapshot(tabId)).toEqual({ pageHasFocus: false, blurSeenThisMove: true });
	});

	it("a hidden document or an inactive tab is 'hidden'", () => {
		focus(tabId, true);
		gate.positionArrived(tabId, sim.now());
		focus(tabId, true, "hidden");
		expect(gate.canExecute(tabId)).toEqual({ ok: false, reason: "hidden" });
		focus(tabId, true, "visible");
		gate.positionArrived(tabId, sim.now());
		expect(gate.canExecute(tabId).ok).toBe(true);
		sim.tabs.activate(other); // another tab in the same window took over
		expect(gate.canExecute(tabId)).toEqual({ ok: false, reason: "hidden" });
		sim.tabs.activate(tabId);
		gate.positionArrived(tabId, sim.now());
		expect(gate.canExecute(tabId).ok).toBe(true);
	});

	it("losing browser focus (windows.onFocusChanged NONE) is a blur edge for every tab in that state", () => {
		focus(tabId, true);
		gate.positionArrived(tabId, sim.now());
		sim.windows.setFocus(sim.chrome.windows.WINDOW_ID_NONE);
		expect(gate.canExecute(tabId)).toEqual({ ok: false, reason: "unfocused" });
		sim.windows.setFocus(1);
		expect(gate.canExecute(tabId)).toEqual({ ok: false, reason: "blur-in-window" });
		focus(tabId, true);
		gate.positionArrived(tabId, sim.now());
		expect(gate.canExecute(tabId).ok).toBe(true);
	});

	it("notifies edge subscribers and forgets closed tabs; dispose removes every listener", () => {
		const edges: Array<[number, boolean]> = [];
		const off = gate.onEdge((id, hasFocus) => edges.push([id, hasFocus]));
		focus(tabId, true);
		focus(tabId, false);
		expect(edges).toEqual([
			[tabId, true],
			[tabId, false],
		]);
		off();
		sim.closeTab(tabId);
		expect(gate.snapshot(tabId)).toEqual({ pageHasFocus: false, blurSeenThisMove: false });
		gate.dispose();
		expect(link.listeners()).toBe(0);
		expect(sim.chrome.windows.onFocusChanged.hasListener).toBeDefined();
	});
});
