// test/service/offscreen-manager.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { closeOffscreen, ensureOffscreen, OFFSCREEN_PAGE_PATH } from "@service/offscreen-manager";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;
beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});

describe("ensureOffscreen", () => {
	it("creates one document for three concurrent calls, with the WORKERS reason", async () => {
		await Promise.all([ensureOffscreen(), ensureOffscreen(), ensureOffscreen()]);
		expect(sim.offscreen.history()).toHaveLength(1);
		expect(sim.offscreen.document()).toMatchObject({
			url: OFFSCREEN_PAGE_PATH,
			reasons: ["WORKERS"],
			justification: "Runs the chess engine in a Web Worker with SharedArrayBuffer",
		});
		expect(OFFSCREEN_PAGE_PATH).toBe("pages/offscreen.html");
	});
	it("is a no-op when a document already exists (getContexts check)", async () => {
		sim.offscreen.adopt(OFFSCREEN_PAGE_PATH);
		await ensureOffscreen();
		await ensureOffscreen();
		expect(sim.offscreen.history()).toHaveLength(1);
	});
	it("tolerates the 'already exists' race", async () => {
		sim.offscreen.adopt(OFFSCREEN_PAGE_PATH);
		// Pretend getContexts is stale (a previous SW instance created the document).
		const runtime = sim.chrome.runtime as unknown as {
			getContexts: (f: unknown, cb: (c: unknown[]) => void) => void;
		};
		const original = runtime.getContexts;
		runtime.getContexts = (_f, cb) => cb([]);
		try {
			await expect(ensureOffscreen()).resolves.toBeUndefined();
		} finally {
			runtime.getContexts = original;
		}
		expect(sim.offscreen.history()).toHaveLength(1);
	});
	it("rethrows other creation failures and allows a retry", async () => {
		const offscreen = sim.chrome.offscreen as unknown as {
			createDocument: (p: unknown, cb: () => void) => void;
		};
		const original = offscreen.createDocument;
		offscreen.createDocument = () => {
			throw new Error("disk on fire");
		};
		try {
			await expect(ensureOffscreen()).rejects.toThrow("disk on fire");
		} finally {
			offscreen.createDocument = original;
		}
		await ensureOffscreen();
		expect(sim.offscreen.hasDocument()).toBe(true);
	});
});

describe("closeOffscreen", () => {
	it("closes an existing document and is a no-op without one", async () => {
		await ensureOffscreen();
		await closeOffscreen();
		expect(sim.offscreen.hasDocument()).toBe(false);
		await expect(closeOffscreen()).resolves.toBeUndefined();
		await ensureOffscreen();
		expect(sim.offscreen.history()).toHaveLength(2);
	});
});
