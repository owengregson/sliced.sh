// test/sim/tabs.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;
const prevChrome = (globalThis as Record<string, unknown>).chrome;
beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});
afterEach(() => {
	(globalThis as Record<string, unknown>).chrome = prevChrome;
});

describe("chrome.tabs fake", () => {
	it("create fires onCreated, onUpdated(loading) and onActivated, and activates the new tab", async () => {
		const events: string[] = [];
		sim.chrome.tabs.onCreated.addListener((t) => void events.push(`created:${t.id}`));
		sim.chrome.tabs.onUpdated.addListener(
			(id, info) => void events.push(`updated:${id}:${info.status}`)
		);
		sim.chrome.tabs.onActivated.addListener((i) => void events.push(`activated:${i.tabId}`));
		const first = await sim.chrome.tabs.create({ url: "https://a.test/" });
		const second = await new Promise<chrome.tabs.Tab>((r) =>
			sim.chrome.tabs.create({ url: "https://b.test/", active: false }, r)
		);
		expect(events).toEqual([
			`created:${first.id}`,
			`updated:${first.id}:loading`,
			`activated:${first.id}`,
			`created:${second.id}`,
			`updated:${second.id}:loading`,
		]);
		expect(first.active).toBe(true);
		expect(second.active).toBe(false);
		expect(first.status).toBe("loading");
	});

	it("query filters by active, status, and match patterns", async () => {
		sim.openTab("https://www.chess.com/play/online");
		sim.openTab("https://lichess.org/abc", { active: false });
		sim.chrome.tabs.create({ url: "https://example.com/", active: false });
		const active = await sim.chrome.tabs.query({ active: true });
		expect(active.map((t) => t.url)).toEqual(["https://www.chess.com/play/online"]);
		const chess = await sim.chrome.tabs.query({ url: ["*://*.chess.com/*", "*://*.lichess.org/*"] });
		expect(chess.map((t) => t.url)).toEqual([
			"https://www.chess.com/play/online",
			"https://lichess.org/abc",
		]);
		expect((await sim.chrome.tabs.query({ status: "loading" })).map((t) => t.url)).toEqual([
			"https://example.com/",
		]);
		const cb = await new Promise<chrome.tabs.Tab[]>((r) =>
			sim.chrome.tabs.query({ active: true, currentWindow: true }, r)
		);
		expect(cb).toHaveLength(1);
	});

	it("get / update / remove handle unknown ids with Chrome's lastError", async () => {
		const { tabId } = sim.openTab("https://www.chess.com/");
		expect((await sim.chrome.tabs.get(tabId)).url).toBe("https://www.chess.com/");
		let err: string | undefined;
		sim.chrome.tabs.get(404, () => {
			err = chrome.runtime.lastError?.message;
		});
		expect(err).toBe("No tab with id: 404.");
		await expect(sim.chrome.tabs.update(404, { url: "x" })).rejects.toThrow("No tab with id: 404.");
		await expect(sim.chrome.tabs.remove(404)).rejects.toThrow("No tab with id: 404.");

		const updates: chrome.tabs.OnUpdatedInfo[] = [];
		sim.chrome.tabs.onUpdated.addListener((_id, info) => void updates.push(info));
		await sim.chrome.tabs.update(tabId, { url: "https://www.chess.com/game/live/1" });
		expect(updates).toEqual([{ url: "https://www.chess.com/game/live/1", status: "loading" }]);
		sim.tabs.setStatus(tabId, "complete");
		expect(updates[1]).toEqual({ status: "complete" });

		const removed: number[] = [];
		sim.chrome.tabs.onRemoved.addListener((id) => void removed.push(id));
		await sim.chrome.tabs.remove(tabId);
		expect(removed).toEqual([tabId]);
		expect(await sim.chrome.tabs.query({})).toEqual([]);
	});

	it("activate / update({active:true}) switch the active tab and fire onActivated once per change", async () => {
		const a = sim.openTab("https://a.test/").tabId;
		const b = sim.openTab("https://b.test/").tabId;
		const seen: number[] = [];
		sim.chrome.tabs.onActivated.addListener((i) => void seen.push(i.tabId));
		sim.tabs.activate(a);
		sim.tabs.activate(a); // no change → no event
		await sim.chrome.tabs.update(b, { active: true });
		expect(seen).toEqual([a, b]);
		expect(sim.tabs.activeTab()?.id).toBe(b);
	});

	it("navigate fires url+loading then complete", () => {
		const { tabId } = sim.openTab("https://a.test/");
		const seen: chrome.tabs.OnUpdatedInfo[] = [];
		sim.chrome.tabs.onUpdated.addListener((_id, info) => void seen.push(info));
		sim.tabs.navigate(tabId, "https://a.test/next");
		expect(seen).toEqual([{ url: "https://a.test/next", status: "loading" }, { status: "complete" }]);
		expect(sim.tabs.get(tabId)?.url).toBe("https://a.test/next");
	});
});
