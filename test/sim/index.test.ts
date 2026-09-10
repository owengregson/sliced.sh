// test/sim/index.test.ts
/** Façade + integration with the real `src/core` wrappers and messaging across contexts. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { debuggerAttach, debuggerSend } from "@core/chrome/debugger";
import { runtimeSendMessage } from "@core/chrome/runtime";
import { chromeSessionGet, onStorageChanged } from "@core/chrome/storage";
import { tabsQuery, tabsSendMessage } from "@core/chrome/tabs";
import { MSG, PORT_NAMES, SESSION_KEYS } from "@core/constants";
import { acceptPorts, connectPort } from "@core/messaging/ports";
import { installMessageRouter } from "@core/messaging/router";
import { createSimulator, getSimulator, type Simulator } from "@test/sim";
import { bootContentContext } from "@test/sim/contexts/content-context";
import { bootPanelContext } from "@test/sim/contexts/panel-context";
import { bootSwContext, type SimContext } from "@test/sim/contexts/sw-context";

let sim: Simulator;
const booted: SimContext[] = [];
const prevChrome = (globalThis as Record<string, unknown>).chrome;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
	sim = createSimulator({ startAt: 1_000_000 });
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});
afterEach(async () => {
	for (const ctx of booted.reverse()) await ctx.teardown();
	booted.length = 0;
	sim.time.uninstall();
	await sim.dispose();
	(globalThis as Record<string, unknown>).chrome = prevChrome;
});

describe("simulator façade", () => {
	it("setup.ts installed a simulator with one active chess.com tab behind the global chrome", () => {
		const installed = getSimulator();
		expect(installed.tabs.activeTab()?.url).toBe("https://www.chess.com/play/online");
		expect(installed.tabs.activeTab()?.status).toBe("complete");
		expect((globalThis as { __sim?: Simulator }).__sim).toBe(installed);
	});

	it("openTab creates a loaded tab with a DOM registered for CDP input; closeTab removes everything", async () => {
		const { tabId, tab, dom } = sim.openTab("https://www.chess.com/abc", { active: false });
		expect(tab.status).toBe("complete");
		expect(tab.active).toBe(false);
		expect(sim.getTabDom(tabId)).toBe(dom);
		dom.setHTML("<div id='sq'></div>");
		dom.layout("#sq", { x: 0, y: 0, width: 10, height: 10 });
		let clicks = 0;
		dom.query("#sq").addEventListener("click", () => void clicks++);
		await debuggerAttach(tabId, "1.3");
		await debuggerSend(tabId, "Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: 5,
			y: 5,
			button: "left",
			buttons: 1,
			clickCount: 1,
		});
		await debuggerSend(tabId, "Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: 5,
			y: 5,
			button: "left",
			buttons: 0,
			clickCount: 1,
		});
		expect(clicks).toBe(1);
		expect(sim.input.events.map((e) => e.type)).toContain("click");
		sim.closeTab(tabId);
		expect(sim.getTabDom(tabId)).toBeUndefined();
		expect(sim.debugger.isAttached(tabId)).toBe(false);
		expect((await tabsQuery({})).map((t) => t.id)).not.toContain(tabId);
	});

	it("the storage wrappers see onChanged fan-out from another context", async () => {
		const sw = await bootSwContext(sim);
		const panel = await bootPanelContext(sim);
		booted.push(sw, panel);
		const seen: unknown[] = [];
		await sw.run(() => {
			onStorageChanged("session", (changes) =>
				seen.push(changes[SESSION_KEYS.autoMoveArmed]?.newValue)
			);
		});
		await panel.chrome.storage.session.set({ [SESSION_KEYS.autoMoveArmed]: { 1: true } });
		expect(seen).toEqual([{ 1: true }]);
		expect(await chromeSessionGet(SESSION_KEYS.autoMoveArmed)).toEqual({ 1: true });
	});

	it("the message router in the SW answers runtimeSendMessage from the panel and tabsSendMessage reaches content", async () => {
		const sw = await bootSwContext(sim);
		booted.push(sw);
		const router = installMessageRouter();
		router.on(MSG.OFFSCREEN_PING, () => ({ ok: true }) as never);
		router.install();
		const panel = await bootPanelContext(sim);
		booted.push(panel);
		expect(await panel.send({ type: MSG.OFFSCREEN_PING })).toEqual({
			success: true,
			response: { ok: true },
		});
		await expect(panel.send({ type: "sl::unknown" })).rejects.toThrow(/message port closed/);

		const { tabId } = sim.openTab("https://www.chess.com/play/online");
		const content = await bootContentContext(sim, tabId);
		booted.push(content);
		const contentRouter = installMessageRouter();
		contentRouter.on(MSG.CONTENT_HELLO, () => undefined);
		contentRouter.install();
		const result = await sw.run(() => tabsSendMessage(tabId, { type: MSG.CONTENT_HELLO }));
		expect(result).toEqual({ success: true, response: { success: true, response: undefined } });
		const missing = await sw.run(() => tabsSendMessage(tabId + 1, { type: MSG.CONTENT_HELLO }));
		expect(missing.success).toBe(false);
		expect(missing.error).toContain("No tab with id");
		await expect(panel.run(() => runtimeSendMessage({ type: "sl::nobody" }))).rejects.toThrow();
		router.dispose();
		contentRouter.dispose();
	});

	it("connectPort/acceptPorts from src pair up across contexts, survive an SW restart via backoff timers", async () => {
		sim.time.install();
		const sw = await bootSwContext(sim);
		booted.push(sw);
		const swSeen: unknown[] = [];
		let accepted = 0;
		const accept = () =>
			acceptPorts<{ kind: "keybinds" }, { kind: "hello"; n: number }>(PORT_NAMES.panel, (port) => {
				accepted += 1;
				port.onMessage((m) => swSeen.push(m));
				port.post({ kind: "keybinds" });
			});
		let stopAccepting = accept();
		const panel = await bootPanelContext(sim);
		booted.push(panel);
		const panelSeen: unknown[] = [];
		const port = await panel.run(() =>
			connectPort<{ kind: "hello"; n: number }, { kind: "keybinds" }>(PORT_NAMES.panel, {
				onMessage: (m) => panelSeen.push(m),
			})
		);
		await port.ready;
		port.post({ kind: "hello", n: 1 });
		await sim.time.flush();
		expect(accepted).toBe(1);
		expect(swSeen).toEqual([{ kind: "hello", n: 1 }]);
		expect(panelSeen).toEqual([{ kind: "keybinds" }]);

		// SW dies: the panel's port disconnects and reconnects with backoff once the SW is back.
		stopAccepting();
		await sw.teardown();
		await sim.time.flush();
		expect(sim.bus.openPortCount()).toBe(0);
		port.post({ kind: "hello", n: 2 }); // queued while disconnected
		const swAgain = await bootSwContext(sim);
		booted[0] = swAgain;
		stopAccepting = accept();
		await sim.time.advance(250); // first reconnect attempt
		await sim.time.flush();
		expect(accepted).toBe(2);
		expect(swSeen).toEqual([
			{ kind: "hello", n: 1 },
			{ kind: "hello", n: 2 },
		]);
		port.disconnect();
		stopAccepting();
		await sim.time.flush();
		expect(sim.bus.openPortCount()).toBe(0);
	});

	it("records executor-style CDP sequences with the virtual clock for timing assertions", async () => {
		sim.time.install();
		const { tabId } = sim.openTab("https://www.chess.com/play/online");
		await debuggerAttach(tabId, "1.3");
		const path = [
			{ x: 100, y: 100, dtMs: 0 },
			{ x: 110, y: 104, dtMs: 8 },
			{ x: 120, y: 109, dtMs: 8 },
		];
		const run = (async () => {
			for (const p of path) {
				if (p.dtMs) await new Promise<void>((r) => setTimeout(r, p.dtMs));
				await debuggerSend(tabId, "Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x: p.x,
					y: p.y,
					button: "none",
					buttons: 0,
				});
			}
		})();
		await sim.time.advance(16);
		await run;
		expect(sim.debugger.commands.map((c) => c.at - 1_000_000)).toEqual([0, 8, 16]);
		expect(sim.input.events.filter((e) => e.type === "pointermove").map((e) => e.x)).toEqual([
			100, 110, 120,
		]);
	});
});
