// test/sim/runtime.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSimulator, type Simulator } from "@test/sim";
import { createRuntimeSubsystem } from "@test/sim/chrome/runtime";
import { NO_RECEIVER_ERROR, PORT_CLOSED_ERROR } from "@test/sim/contexts/bus";

let sim: Simulator;
const prevChrome = (globalThis as Record<string, unknown>).chrome;
beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});
afterEach(() => {
	(globalThis as Record<string, unknown>).chrome = prevChrome;
});

function panelRuntime(s: Simulator) {
	return createRuntimeSubsystem(s.bus, s.bus.registerContext("panel"), {
		extensionContexts: s.extensionContexts,
	});
}

describe("chrome.runtime fake", () => {
	it("exposes id, getURL and a manifest", () => {
		const rt = sim.chrome.runtime;
		expect(rt.id).toBe(sim.extensionId);
		expect(rt.getURL("/pages/panel.html")).toBe(
			`chrome-extension://${sim.extensionId}/pages/panel.html`
		);
		expect(rt.getManifest().manifest_version).toBe(3);
	});

	it("sendMessage with no receiver: callback sees lastError, Promise form rejects", async () => {
		let error: string | undefined;
		let response: unknown = "untouched";
		sim.chrome.runtime.sendMessage({ type: "x" }, (r: unknown) => {
			response = r;
			error = chrome.runtime.lastError?.message;
		});
		expect(response).toBeUndefined();
		expect(error).toBe(NO_RECEIVER_ERROR);
		await expect(sim.chrome.runtime.sendMessage({ type: "x" })).rejects.toThrow(NO_RECEIVER_ERROR);
	});

	it("sendMessage supports sync sendResponse, async (return true) and the port-closed error", async () => {
		const panel = panelRuntime(sim);
		panel.api.onMessage.addListener((msg, _sender, sendResponse) => {
			const m = msg as { type: string };
			if (m.type === "sync") {
				sendResponse({ ok: "sync" });
				return false;
			}
			if (m.type === "async") {
				queueMicrotask(() => sendResponse({ ok: "async" }));
				return true;
			}
			return undefined;
		});
		expect((await sim.chrome.runtime.sendMessage({ type: "sync" })) as unknown).toEqual({
			ok: "sync",
		});
		expect((await sim.chrome.runtime.sendMessage({ type: "async" })) as unknown).toEqual({
			ok: "async",
		});
		await expect(sim.chrome.runtime.sendMessage({ type: "ignored" })).rejects.toThrow(
			PORT_CLOSED_ERROR
		);
	});

	it("accepts the (extensionId, message, cb) and (message, options, cb) overloads", async () => {
		const panel = panelRuntime(sim);
		const got: unknown[] = [];
		panel.api.onMessage.addListener((msg, _s, sendResponse) => {
			got.push(msg);
			sendResponse(1);
			return undefined;
		});
		await sim.chrome.runtime.sendMessage(sim.extensionId, { type: "a" });
		await sim.chrome.runtime.sendMessage({ type: "b" }, { includeTlsChannelId: false });
		expect(got).toEqual([{ type: "a" }, { type: "b" }]);
	});

	it("getContexts lists the SW, booted panels, and the offscreen document; filters by contextTypes", async () => {
		const before = await sim.chrome.runtime.getContexts({});
		expect(before.map((c) => c.contextType)).toEqual(["BACKGROUND"]);
		panelRuntime(sim);
		await sim.chrome.offscreen.createDocument({
			url: "pages/offscreen.html",
			reasons: ["WORKERS"],
			justification: "engine",
		});
		const all = await sim.chrome.runtime.getContexts({});
		expect(all.map((c) => c.contextType).sort()).toEqual([
			"BACKGROUND",
			"OFFSCREEN_DOCUMENT",
			"SIDE_PANEL",
		]);
		const offscreen = await new Promise<chrome.runtime.ExtensionContext[]>((r) =>
			sim.chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }, r)
		);
		expect(offscreen).toHaveLength(1);
		expect(offscreen[0]?.documentUrl).toContain("pages/offscreen.html");
	});

	it("lastError can be assigned directly by hand-rolled stubs and is cleared after", () => {
		const runtime = sim.chrome.runtime as { lastError: { message: string } | undefined };
		runtime.lastError = { message: "manual" };
		expect(chrome.runtime.lastError?.message).toBe("manual");
		runtime.lastError = undefined;
		expect(sim.chrome.runtime.lastError).toBeUndefined();
	});

	it("lifecycle events fire only through the helpers", () => {
		const seen: string[] = [];
		sim.chrome.runtime.onInstalled.addListener((d) => seen.push(`installed:${d.reason}`));
		sim.chrome.runtime.onStartup.addListener(() => seen.push("startup"));
		sim.chrome.runtime.onSuspend.addListener(() => seen.push("suspend"));
		expect(seen).toEqual([]);
		sim.runtime.fireOnInstalled({ reason: "install" });
		sim.runtime.fireOnStartup();
		sim.runtime.fireOnSuspend();
		expect(seen).toEqual(["installed:install", "startup", "suspend"]);
		expect(sim.runtime.listenerCounts()).toMatchObject({ installed: 1, startup: 1, suspend: 1 });
	});
});
