// test/sim/bus.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSimulator, type Simulator } from "@test/sim";
import { createRuntimeSubsystem } from "@test/sim/chrome/runtime";
import {
	DISCONNECTED_PORT_ERROR,
	NO_RECEIVER_ERROR,
	PORT_CLOSED_ERROR,
} from "@test/sim/contexts/bus";

let sim: Simulator;
const prevChrome = (globalThis as Record<string, unknown>).chrome;
beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});
afterEach(() => {
	(globalThis as Record<string, unknown>).chrome = prevChrome;
});

const runtimeFor = (s: Simulator, kind: "panel" | "offscreen" | "content", tabId?: number) =>
	createRuntimeSubsystem(
		s.bus,
		s.bus.registerContext(kind, tabId === undefined ? {} : { tabId, url: "https://www.chess.com/x" })
	);

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("bus: one-shot messages", () => {
	it("delivers runtime.sendMessage to every other non-content context, never back to the sender", async () => {
		const panel = runtimeFor(sim, "panel");
		const offscreen = runtimeFor(sim, "offscreen");
		const content = runtimeFor(sim, "content", 1);
		const seen: string[] = [];
		sim.chrome.runtime.onMessage.addListener(() => void seen.push("sw"));
		panel.api.onMessage.addListener(() => void seen.push("panel"));
		offscreen.api.onMessage.addListener(() => void seen.push("offscreen"));
		content.api.onMessage.addListener(() => void seen.push("content"));

		sim.chrome.runtime.sendMessage({ type: "from-sw" }, () => {});
		expect(seen).toEqual(["panel", "offscreen"]);
		seen.length = 0;
		panel.api.sendMessage({ type: "from-panel" }, () => {});
		expect(seen).toEqual(["sw", "offscreen"]);
		seen.length = 0;
		content.api.sendMessage({ type: "from-content" }, () => {});
		expect(seen).toEqual(["sw", "panel", "offscreen"]);
	});

	it("sender carries the extension id and, for content scripts, the tab", () => {
		const { tabId } = sim.openTab("https://www.chess.com/play/online");
		const content = runtimeFor(sim, "content", tabId);
		const panel = runtimeFor(sim, "panel");
		const senders: chrome.runtime.MessageSender[] = [];
		sim.chrome.runtime.onMessage.addListener((_m, sender) => void senders.push(sender));
		content.api.sendMessage({ type: "hello" }, () => {});
		panel.api.sendMessage({ type: "hello" }, () => {});
		expect(senders[0]?.id).toBe(sim.extensionId);
		expect(senders[0]?.tab?.id).toBe(tabId);
		expect(senders[0]?.tab?.url).toBe("https://www.chess.com/play/online");
		expect(senders[0]?.frameId).toBe(0);
		expect(senders[1]?.tab).toBeUndefined();
		expect(senders[1]?.url).toBe(`chrome-extension://${sim.extensionId}/pages/panel.html`);
	});

	it("first sendResponse wins; messages and responses are JSON clones", async () => {
		const panel = runtimeFor(sim, "panel");
		const offscreen = runtimeFor(sim, "offscreen");
		panel.api.onMessage.addListener((_m, _s, sendResponse) => {
			sendResponse({ from: "panel" });
			return undefined;
		});
		offscreen.api.onMessage.addListener((_m, _s, sendResponse) => {
			sendResponse({ from: "offscreen" });
			return undefined;
		});
		const original = { type: "x", fn: () => 1, nested: { u: undefined, n: 1 } };
		let received: unknown;
		panel.api.onMessage.addListener((m) => {
			received = m;
			return undefined;
		});
		const reply = await sim.chrome.runtime.sendMessage(original);
		expect(reply).toEqual({ from: "panel" });
		expect(received).toEqual({ type: "x", nested: { n: 1 } });
	});

	it("tabs.sendMessage targets exactly the content context of that tab", async () => {
		const a = sim.openTab("https://www.chess.com/a").tabId;
		const b = sim.openTab("https://lichess.org/b").tabId;
		const contentA = runtimeFor(sim, "content", a);
		const contentB = runtimeFor(sim, "content", b);
		const seen: string[] = [];
		contentA.api.onMessage.addListener((_m, _s, send) => {
			seen.push("a");
			send("a-reply");
			return undefined;
		});
		contentB.api.onMessage.addListener((_m, _s, send) => {
			seen.push("b");
			send("b-reply");
			return undefined;
		});
		expect((await sim.chrome.tabs.sendMessage(b, { type: "ping" })) as unknown).toBe("b-reply");
		expect(seen).toEqual(["b"]);
		const c = sim.openTab("https://www.chess.com/c").tabId;
		await expect(sim.chrome.tabs.sendMessage(c, { type: "ping" })).rejects.toThrow(NO_RECEIVER_ERROR);
		await expect(sim.chrome.tabs.sendMessage(999, { type: "ping" })).rejects.toThrow(
			"No tab with id: 999."
		);
		contentB.cleanup();
		await expect(sim.chrome.tabs.sendMessage(b, { type: "ping" })).rejects.toThrow(NO_RECEIVER_ERROR);
	});

	it("the sender's callback runs under the sender's globals even for a synchronous answer", () => {
		const panel = runtimeFor(sim, "panel");
		const panelChrome = { runtime: panel.api } as unknown as typeof chrome;
		const ctx = sim.bus.getContext(panel.context.id)!;
		ctx.activate = () => {
			const restoreChrome = (globalThis as { chrome: unknown }).chrome;
			(globalThis as { chrome: unknown }).chrome = panelChrome;
			const restoreActive = sim.bus.activate(ctx.id);
			return () => {
				restoreActive();
				(globalThis as { chrome: unknown }).chrome = restoreChrome;
			};
		};
		sim.chrome.runtime.onMessage.addListener((_m, _s, send) => {
			expect(globalThis.chrome).toBe(sim.chrome); // listener runs as the SW
			send("ok");
			return undefined;
		});
		let seenChrome: unknown;
		sim.bus.runAs(ctx.id, () =>
			panel.api.sendMessage({ type: "x" }, () => {
				seenChrome = globalThis.chrome; // callback runs as the panel again
			})
		);
		expect(seenChrome).toBe(panelChrome);
		expect(globalThis.chrome).toBe(sim.chrome);
	});

	it("listeners that neither respond nor return true close the port", async () => {
		const panel = runtimeFor(sim, "panel");
		panel.api.onMessage.addListener(() => undefined);
		await expect(sim.chrome.runtime.sendMessage({ type: "x" })).rejects.toThrow(PORT_CLOSED_ERROR);
	});
});

describe("bus: ports", () => {
	it("connect pairs a port with each listening context; postMessage flows both ways on a microtask", async () => {
		const panel = runtimeFor(sim, "panel");
		const swPorts: chrome.runtime.Port[] = [];
		sim.chrome.runtime.onConnect.addListener((p) => void swPorts.push(p));
		const port = panel.api.connect({ name: "sl-panel" });
		expect(swPorts).toHaveLength(1);
		const swPort = swPorts[0]!;
		expect(swPort.name).toBe("sl-panel");
		expect(port.name).toBe("sl-panel");
		expect(swPort.sender?.id).toBe(sim.extensionId);
		expect(port.sender).toBeUndefined();

		const swSeen: unknown[] = [];
		const panelSeen: unknown[] = [];
		swPort.onMessage.addListener((m, p) => {
			swSeen.push(m);
			expect(p).toBe(swPort);
		});
		port.onMessage.addListener((m) => void panelSeen.push(m));
		port.postMessage({ n: 1 });
		swPort.postMessage({ n: 2 });
		expect(swSeen).toEqual([]); // not yet — delivery is asynchronous like Chrome
		await tick();
		expect(swSeen).toEqual([{ n: 1 }]);
		expect(panelSeen).toEqual([{ n: 2 }]);
		expect(sim.bus.openPortCount()).toBe(1);
	});

	it("a message posted right after connect reaches a listener attached after connect returns", async () => {
		const panel = runtimeFor(sim, "panel");
		sim.chrome.runtime.onConnect.addListener((p) => p.postMessage({ hello: true }));
		const port = panel.api.connect({ name: "sl-panel" });
		const seen: unknown[] = [];
		port.onMessage.addListener((m) => void seen.push(m));
		await tick();
		expect(seen).toEqual([{ hello: true }]);
	});

	it("disconnect fires onDisconnect on the other end only, and posting afterwards throws", async () => {
		const panel = runtimeFor(sim, "panel");
		let swPort: chrome.runtime.Port | undefined;
		sim.chrome.runtime.onConnect.addListener((p) => {
			swPort = p;
		});
		const port = panel.api.connect({ name: "sl-panel" });
		const events: string[] = [];
		port.onDisconnect.addListener(() => void events.push("panel-side"));
		swPort!.onDisconnect.addListener(() => {
			events.push(`sw-side:${chrome.runtime.lastError?.message ?? "none"}`);
		});
		port.disconnect();
		await tick();
		expect(events).toEqual(["sw-side:none"]);
		expect(() => port.postMessage(1)).toThrow(DISCONNECTED_PORT_ERROR);
		expect(() => swPort!.postMessage(1)).toThrow(DISCONNECTED_PORT_ERROR);
		port.disconnect(); // idempotent
		expect(sim.bus.openPortCount()).toBe(0);
	});

	it("connecting with nobody listening disconnects the port with the no-receiver lastError", async () => {
		const panel = runtimeFor(sim, "panel");
		const port = panel.api.connect({ name: "sl-panel" });
		let reason: string | undefined = "not-fired";
		port.onDisconnect.addListener(() => {
			reason = chrome.runtime.lastError?.message;
		});
		await tick();
		expect(reason).toBe(NO_RECEIVER_ERROR);
	});

	it("port names are passed through so the SW side can filter", () => {
		const panel = runtimeFor(sim, "panel");
		const names: string[] = [];
		sim.chrome.runtime.onConnect.addListener((p) => void names.push(p.name));
		panel.api.connect({ name: "sl-game" });
		panel.api.connect(sim.extensionId, { name: "sl-engine" });
		expect(names).toEqual(["sl-game", "sl-engine"]);
	});

	it("content contexts never receive onConnect; ports die with their context", async () => {
		const content = runtimeFor(sim, "content", 1);
		const panel = runtimeFor(sim, "panel");
		content.api.onConnect.addListener(() => {
			throw new Error("content must not receive runtime.onConnect");
		});
		let swPort: chrome.runtime.Port | undefined;
		sim.chrome.runtime.onConnect.addListener((p) => {
			swPort = p;
		});
		panel.api.connect({ name: "sl-panel" });
		let swDisconnected = false;
		swPort!.onDisconnect.addListener(() => {
			swDisconnected = true;
		});
		sim.bus.unregisterContext(panel.context.id);
		await tick();
		expect(swDisconnected).toBe(true);
		expect(sim.bus.contexts().map((c) => c.id)).not.toContain(panel.context.id);
	});
});

describe("bus: listener ownership", () => {
	it("attributes listeners on shared fakes to the active context and drops them on clearContext", () => {
		const panel = sim.bus.registerContext("panel");
		const restore = sim.bus.activate(panel.id);
		sim.chrome.storage.onChanged.addListener(() => {});
		sim.chrome.tabs.onUpdated.addListener(() => {});
		restore();
		sim.chrome.storage.onChanged.addListener(() => {}); // owned by the SW
		expect(sim.storage.listenerCount()).toBe(2);
		sim.bus.clearContext(panel.id);
		expect(sim.storage.listenerCount()).toBe(1);
		expect(sim.chrome.tabs.onUpdated.hasListener).toBeDefined();
		sim.bus.clearContext(sim.bus.defaultContext.id);
		expect(sim.storage.listenerCount()).toBe(0);
		expect(() => sim.bus.unregisterContext(sim.bus.defaultContext.id)).toThrow();
	});
});
