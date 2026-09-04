// test/sim/debugger.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { debuggerAttach, debuggerDetach, debuggerSend } from "@core/chrome/debugger";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;
let tabId: number;
beforeEach(() => {
	sim = createSimulator({ startAt: 1_000_000 });
	tabId = sim.openTab("https://www.chess.com/play/online").tabId;
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});

describe("chrome.debugger fake", () => {
	it("attach/detach track state per tab with Chrome's errors", async () => {
		await debuggerAttach(tabId, "1.3");
		expect(sim.debugger.isAttached(tabId)).toBe(true);
		await expect(debuggerAttach(tabId, "1.3")).rejects.toThrow(
			`Another debugger is already attached to the tab with id: ${tabId}.`
		);
		await expect(debuggerAttach(404, "1.3")).rejects.toThrow("No tab with given id 404.");
		await debuggerDetach(tabId);
		expect(sim.debugger.isAttached(tabId)).toBe(false);
		await expect(debuggerDetach(tabId)).rejects.toThrow(
			`Debugger is not attached to the tab with id: ${tabId}.`
		);
		expect(sim.debugger.attachments.map((a) => a.action)).toEqual(["attach", "detach"]);
	});

	it("sendCommand requires an attachment and records every command with a virtual-clock timestamp", async () => {
		await expect(
			debuggerSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 })
		).rejects.toThrow("Debugger is not attached");
		await debuggerAttach(tabId, "1.3");
		await debuggerSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10 });
		await sim.time.advance(8);
		await debuggerSend(tabId, "Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: 10,
			y: 10,
			button: "left",
			buttons: 1,
			clickCount: 1,
		});
		const viaCb = await new Promise<unknown>((r) =>
			sim.chrome.debugger.sendCommand({ tabId }, "Page.enable", undefined, r)
		);
		expect(viaCb).toEqual({});
		expect(sim.debugger.commands).toEqual([
			{
				tabId,
				method: "Input.dispatchMouseEvent",
				params: { type: "mouseMoved", x: 10, y: 10 },
				at: 1_000_000,
			},
			{
				tabId,
				method: "Input.dispatchMouseEvent",
				params: { type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1, clickCount: 1 },
				at: 1_000_008,
			},
			{ tabId, method: "Page.enable", params: undefined, at: 1_000_008 },
		]);
		expect(sim.debugger.commandsFor("Page.enable")).toHaveLength(1);
		sim.debugger.clearCommands();
		expect(sim.debugger.commands).toEqual([]);
	});

	it("respond(method, handler) scripts results (sync or async) and errors surface as lastError", async () => {
		await debuggerAttach(tabId, "1.3");
		const off = sim.debugger.respond("Runtime.evaluate", (params) => ({
			result: { type: "string", value: `evaluated:${(params as { expression: string }).expression}` },
		}));
		expect(await debuggerSend(tabId, "Runtime.evaluate", { expression: "1+1" })).toEqual({
			result: { type: "string", value: "evaluated:1+1" },
		});
		off();
		expect(await debuggerSend(tabId, "Runtime.evaluate", { expression: "1+1" })).toEqual({
			result: { type: "undefined" },
		});
		sim.debugger.respond("Runtime.evaluate", async () => {
			throw new Error("Cannot access a chrome:// URL");
		});
		await expect(debuggerSend(tabId, "Runtime.evaluate", { expression: "x" })).rejects.toThrow(
			"Cannot access a chrome:// URL"
		);
		let seen: string | undefined;
		await new Promise<void>((resolve) =>
			sim.chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {}, () => {
				seen = chrome.runtime.lastError?.message;
				resolve();
			})
		);
		expect(seen).toBe("Cannot access a chrome:// URL");
	});

	it("getTargets lists tabs with their attachment flag; onDetach fires for user/tab-closed detaches only", async () => {
		const other = sim.openTab("https://lichess.org/", { active: false }).tabId;
		await debuggerAttach(tabId, "1.3");
		const targets = await sim.chrome.debugger.getTargets();
		expect(targets.map((t) => [t.tabId, t.attached])).toEqual([
			[tabId, true],
			[other, false],
		]);
		const detaches: string[] = [];
		sim.chrome.debugger.onDetach.addListener(
			(src, reason) => void detaches.push(`${src.tabId}:${reason}`)
		);
		await debuggerDetach(tabId); // own detach → no event
		expect(detaches).toEqual([]);
		await debuggerAttach(tabId, "1.3");
		sim.debugger.detachByUser(tabId);
		expect(detaches).toEqual([`${tabId}:canceled_by_user`]);
		expect(sim.debugger.isAttached(tabId)).toBe(false);
		await debuggerAttach(other, "1.3");
		sim.closeTab(other);
		expect(detaches).toEqual([`${tabId}:canceled_by_user`, `${other}:target_closed`]);
	});

	it("onEvent delivers CDP events emitted by the test", async () => {
		const seen: string[] = [];
		sim.chrome.debugger.onEvent.addListener(
			(src, method) => void seen.push(`${src.tabId}:${method}`)
		);
		sim.debugger.emitEvent(tabId, "Runtime.consoleAPICalled", { type: "log" });
		expect(seen).toEqual([`${tabId}:Runtime.consoleAPICalled`]);
	});
});
