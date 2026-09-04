// test/sim/storage.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;
let storage: typeof chrome.storage;
const prevChrome = (globalThis as Record<string, unknown>).chrome;
beforeEach(() => {
	sim = createSimulator({ storageLocal: { seeded: 1 } });
	storage = sim.chrome.storage;
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});
afterEach(() => {
	(globalThis as Record<string, unknown>).chrome = prevChrome;
});

describe("chrome.storage fake", () => {
	it("get supports string / array / object-with-defaults / null keys, in callback and Promise form", async () => {
		storage.local.set({ a: { n: 1 }, b: "x" });
		const byString = await new Promise<Record<string, unknown>>((r) => sim.storage.local.get("a", r));
		expect(byString).toEqual({ a: { n: 1 } });
		expect(await sim.storage.local.get(["a", "b", "missing"])).toEqual({ a: { n: 1 }, b: "x" });
		expect(await sim.storage.local.get({ missing: "dflt", b: "ignored" })).toEqual({
			missing: "dflt",
			b: "x",
		});
		expect(await sim.storage.local.get(null)).toEqual({ seeded: 1, a: { n: 1 }, b: "x" });
		const all = await new Promise<Record<string, unknown>>((r) => sim.storage.local.get(r));
		expect(all).toEqual({ seeded: 1, a: { n: 1 }, b: "x" });
	});

	it("values are JSON-cloned on write and read (no shared references)", async () => {
		const value = { nested: { list: [1, 2] } };
		storage.local.set({ v: value });
		value.nested.list.push(3);
		const read = (await sim.storage.local.get("v")) as { v: { nested: { list: number[] } } };
		expect(read.v.nested.list).toEqual([1, 2]);
		read.v.nested.list.push(9);
		expect(sim.storage.data.local.v).toEqual({ nested: { list: [1, 2] } });
	});

	it("session and local are independent", async () => {
		await storage.session.set({ s: 1 });
		expect(await sim.storage.local.get("s")).toEqual({});
		expect(await sim.storage.session.get("s")).toEqual({ s: 1 });
	});

	it("onChanged fires synchronously with oldValue/newValue, for every listener and both areas", async () => {
		const seen: Array<[Record<string, chrome.storage.StorageChange>, string]> = [];
		const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void =>
			void seen.push([changes, area]);
		storage.onChanged.addListener(listener);
		storage.local.set({ seeded: 2, fresh: true });
		expect(seen).toEqual([
			[{ seeded: { oldValue: 1, newValue: 2 }, fresh: { newValue: true } }, "local"],
		]);
		storage.session.set({ k: "v" });
		expect(seen[1]).toEqual([{ k: { newValue: "v" } }, "session"]);
		storage.local.remove("seeded");
		expect(seen[2]).toEqual([{ seeded: { oldValue: 2 } }, "local"]);
		storage.local.remove("nope"); // no-op → no event
		expect(seen).toHaveLength(3);
		storage.onChanged.removeListener(listener);
		storage.local.set({ x: 1 });
		expect(seen).toHaveLength(3);
		expect(storage.onChanged.hasListener(listener)).toBe(false);
	});

	it("per-area onChanged and clear() are supported", () => {
		const seen: Record<string, chrome.storage.StorageChange>[] = [];
		storage.local.onChanged.addListener((c) => seen.push(c));
		storage.local.clear();
		expect(seen).toEqual([{ seeded: { oldValue: 1 } }]);
		expect(sim.storage.data.local).toEqual({});
	});

	it("failNextWith sets lastError during the callback and rejects the Promise form", async () => {
		sim.storage.failNextWith("QUOTA_BYTES quota exceeded");
		let seen: string | undefined;
		storage.local.set({ big: 1 }, () => {
			seen = chrome.runtime.lastError?.message;
		});
		expect(seen).toBe("QUOTA_BYTES quota exceeded");
		expect(sim.chrome.runtime.lastError).toBeUndefined();
		expect(sim.storage.data.local.big).toBeUndefined();
		sim.storage.failNextWith("boom");
		await expect(sim.storage.local.get("seeded")).rejects.toThrow("boom");
		expect(await sim.storage.local.get("seeded")).toEqual({ seeded: 1 });
	});

	it("records unchecked lastError when a callback never reads it", () => {
		sim.storage.failNextWith("ignored");
		storage.local.set({ a: 1 }, () => {});
		expect(sim.bus.lastError.unchecked).toEqual(["ignored"]);
	});
});
