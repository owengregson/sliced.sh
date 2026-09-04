// test/sim/contexts.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSimulator, type Simulator } from "@test/sim";
import { bootContentContext } from "@test/sim/contexts/content-context";
import { bootOffscreenContext } from "@test/sim/contexts/offscreen-context";
import { bootPanelContext } from "@test/sim/contexts/panel-context";
import { bootSwContext, type SimContext } from "@test/sim/contexts/sw-context";

let sim: Simulator;
const booted: SimContext[] = [];
const prevChrome = (globalThis as Record<string, unknown>).chrome;

beforeEach(() => {
	sim = createSimulator();
});
afterEach(async () => {
	for (const ctx of booted.reverse()) await ctx.teardown();
	booted.length = 0;
	(globalThis as Record<string, unknown>).chrome = prevChrome;
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("context booters", () => {
	it("bootSwContext installs sim.chrome, runs the entry, and refuses a second boot until teardown", async () => {
		let entryChrome: unknown;
		const sw = await bootSwContext(sim, {
			entry: () => {
				entryChrome = globalThis.chrome;
			},
		});
		booted.push(sw);
		expect(entryChrome).toBe(sim.chrome);
		expect(globalThis.chrome).toBe(sim.chrome);
		expect(sw.id).toBe(sim.bus.defaultContext.id);
		expect(sw.runtime).toBe(sim.runtime);
		await expect(bootSwContext(sim)).rejects.toThrow(/already running/);
		await sw.teardown();
		booted.length = 0;
		booted.push(await bootSwContext(sim));
	});

	it("SW teardown is a service-worker termination: listeners and ports go, session storage stays", async () => {
		const sw = await bootSwContext(sim);
		sim.chrome.runtime.onMessage.addListener(() => undefined);
		sim.chrome.storage.onChanged.addListener(() => {});
		sim.chrome.alarms.onAlarm.addListener(() => {});
		sim.chrome.tabs.onUpdated.addListener(() => {});
		await sim.chrome.storage.session.set({ flags: { 1: true } });
		const panel = await bootPanelContext(sim);
		booted.push(panel);
		let swPort: chrome.runtime.Port | undefined;
		sim.chrome.runtime.onConnect.addListener((p) => {
			swPort = p;
		});
		const port = panel.chrome.runtime.connect({ name: "sl-panel" });
		expect(swPort).toBeDefined();
		let disconnected = false;
		port.onDisconnect.addListener(() => {
			disconnected = true;
		});

		await sw.teardown();
		expect(sim.runtime.listenerCounts().message).toBe(0);
		expect(sim.storage.listenerCount()).toBe(0);
		expect(disconnected).toBe(true);
		expect(sim.bus.openPortCount()).toBe(0);
		expect(await sim.storage.session.get("flags")).toEqual({ flags: { 1: true } });
		await expect(panel.send({ type: "x" })).rejects.toThrow(/Receiving end does not exist/);

		// restart
		const again = await bootSwContext(sim);
		booted.push(again);
		sim.chrome.runtime.onMessage.addListener((_m, _s, send) => {
			send("alive");
			return undefined;
		});
		expect(await panel.send({ type: "x" })).toBe("alive");
	});

	it("bootPanelContext gives the panel its own runtime, DOM globals, and a send() through the bus", async () => {
		const sw = await bootSwContext(sim);
		booted.push(sw);
		sim.chrome.runtime.onMessage.addListener((msg, sender, send) => {
			send({ echo: msg, from: sender.url });
			return undefined;
		});
		const panel = await bootPanelContext(sim, { html: "<div id='root'></div>" });
		booted.push(panel);
		expect(globalThis.chrome).toBe(panel.chrome);
		expect(globalThis.window as unknown).toBe(panel.window);
		expect(globalThis.document.getElementById("root")).not.toBeNull();
		expect(panel.window.location.href).toBe(`chrome-extension://${sim.extensionId}/pages/panel.html`);
		expect(panel.chrome.tabs).toBe(sim.chrome.tabs);
		expect(panel.chrome.debugger).toBe(sim.chrome.debugger); // extension pages have the full API
		expect(panel.chrome.alarms).toBe(sim.chrome.alarms);
		expect(await panel.send({ type: "hi" })).toEqual({
			echo: { type: "hi" },
			from: `chrome-extension://${sim.extensionId}/pages/panel.html`,
		});
		const contexts = await sim.chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
		expect(contexts).toHaveLength(1);
		await panel.teardown();
		booted.pop();
		expect(globalThis.chrome).toBe(sim.chrome);
		expect(await sim.chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).toEqual([]);
	});

	it("bootContentContext binds to the tab's DOM, receives tabs.sendMessage, sends with sender.tab, dies with the tab", async () => {
		const sw = await bootSwContext(sim);
		booted.push(sw);
		const { tabId, dom } = sim.openTab("https://www.chess.com/play/online");
		await expect(bootContentContext(sim, 999)).rejects.toThrow(/no tab 999/);
		const content = await bootContentContext(sim, tabId);
		booted.push(content);
		expect(globalThis.window as unknown).toBe(dom.window);
		expect(content.dom).toBe(dom);
		expect((content.chrome as { tabs?: unknown }).tabs).toBeUndefined();
		content.chrome.runtime.onMessage.addListener((msg, _s, send) => {
			send({ got: msg });
			return undefined;
		});
		expect((await sim.chrome.tabs.sendMessage(tabId, { type: "ping" })) as unknown).toEqual({
			got: { type: "ping" },
		});
		let sender: chrome.runtime.MessageSender | undefined;
		sim.chrome.runtime.onMessage.addListener((_m, s, send) => {
			sender = s;
			send(1);
			return undefined;
		});
		await content.chrome.runtime.sendMessage({ type: "hello" });
		expect(sender?.tab?.id).toBe(tabId);
		expect(sender?.url).toBe("https://www.chess.com/play/online");
		sim.closeTab(tabId);
		await tick();
		booted.pop();
		await expect(sim.chrome.tabs.sendMessage(tabId, { type: "ping" })).rejects.toThrow(
			/No tab with id/
		);
		expect(sim.bus.contexts().some((c) => c.kind === "content")).toBe(false);
		expect(globalThis.chrome).toBe(sim.chrome);
	});

	it("bootOffscreenContext adopts a document, is listed by getContexts, and closeDocument tears it down (ports drop)", async () => {
		const sw = await bootSwContext(sim);
		booted.push(sw);
		const offscreen = await bootOffscreenContext(sim);
		booted.push(offscreen);
		expect(sim.offscreen.hasDocument()).toBe(true);
		const listed = await sim.chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
		expect(listed).toHaveLength(1);
		expect(listed[0]?.contextId).toBe(offscreen.id);
		expect(offscreen.window.location.href).toBe(
			`chrome-extension://${sim.extensionId}/pages/offscreen.html`
		);
		let swPort: chrome.runtime.Port | undefined;
		sim.chrome.runtime.onConnect.addListener((p) => {
			swPort = p;
		});
		offscreen.chrome.runtime.connect({ name: "sl-engine" });
		let swSawDisconnect = false;
		swPort!.onDisconnect.addListener(() => {
			swSawDisconnect = true;
		});
		await sim.chrome.offscreen.closeDocument();
		await tick();
		booted.pop();
		expect(swSawDisconnect).toBe(true);
		expect(sim.bus.contexts().some((c) => c.kind === "offscreen")).toBe(false);
		expect(await sim.chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).toEqual(
			[]
		);
	});

	it("activate()/run() switch which context owns the globals; teardown restores LIFO", async () => {
		const sw = await bootSwContext(sim);
		const panel = await bootPanelContext(sim);
		const offscreen = await bootOffscreenContext(sim);
		booted.push(sw, panel, offscreen);
		expect(globalThis.chrome).toBe(offscreen.chrome);
		await panel.run(() => {
			expect(globalThis.chrome).toBe(panel.chrome);
			expect(sim.bus.activeContextId()).toBe(panel.id);
		});
		expect(globalThis.chrome).toBe(offscreen.chrome);
		const restore = sw.activate();
		expect(globalThis.chrome).toBe(sim.chrome);
		restore();
		expect(globalThis.chrome).toBe(offscreen.chrome);
		await offscreen.teardown();
		expect(globalThis.chrome).toBe(panel.chrome);
		await panel.teardown();
		expect(globalThis.chrome).toBe(sim.chrome);
		booted.length = 0;
		booted.push(sw);
	});

	it("SW teardown cancels the timers the SW armed; other contexts' timers survive", async () => {
		sim.time.install();
		try {
			const sw = await bootSwContext(sim);
			const fired: string[] = [];
			setInterval(() => fired.push("sw-interval"), 10); // armed while the SW is active
			setTimeout(() => fired.push("sw-timeout"), 25);
			const panel = await bootPanelContext(sim);
			booted.push(panel);
			setTimeout(() => fired.push("panel-timeout"), 30); // armed while the panel is active
			await sim.time.advance(15);
			expect(fired).toEqual(["sw-interval"]);
			await sw.teardown();
			expect(sim.time.pendingTimers()).toBe(1);
			await sim.time.advance(100);
			expect(fired).toEqual(["sw-interval", "panel-timeout"]);
			expect(sim.time.pendingTimers()).toBe(0);
			booted.push(await bootSwContext(sim));
		} finally {
			sim.time.uninstall();
		}
	});

	it("non-LIFO teardown (content booted first, torn down first) leaves the panel's globals intact and ends clean", async () => {
		const sw = await bootSwContext(sim);
		booted.push(sw);
		const { tabId, dom } = sim.openTab("https://www.chess.com/play/online");
		const content = await bootContentContext(sim, tabId);
		const panel = await bootPanelContext(sim);
		expect(globalThis.window as unknown).toBe(panel.window);
		sim.closeTab(tabId); // tears the content context down while the panel is on top
		await tick();
		expect(globalThis.window as unknown).toBe(panel.window);
		expect(globalThis.chrome as unknown).toBe(panel.chrome);
		expect((globalThis as { document?: unknown }).document).toBe(panel.document);
		await panel.teardown();
		expect((globalThis as { window?: unknown }).window).not.toBe(dom.window);
		expect("window" in globalThis).toBe(false);
		expect(globalThis.chrome as unknown).toBe(sim.chrome);
		await content.teardown(); // already torn down by the tab closing — must be a no-op
		expect(globalThis.chrome as unknown).toBe(sim.chrome);
	});

	it("a failing entry unwinds the boot", async () => {
		await expect(
			bootPanelContext(sim, {
				entry: () => {
					throw new Error("panel import failed");
				},
			})
		).rejects.toThrow("panel import failed");
		expect(sim.bus.contexts().some((c) => c.kind === "panel")).toBe(false);
		expect(globalThis.chrome as unknown).toBe(prevChrome);
	});
});
