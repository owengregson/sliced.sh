// test/sim/offscreen.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { offscreenClose, offscreenEnsure } from "@core/chrome/offscreen";
import { createSimulator, type Simulator } from "@test/sim";
import { NO_DOCUMENT_ERROR, SINGLE_DOCUMENT_ERROR } from "@test/sim/chrome/offscreen";

let sim: Simulator;
beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});

const params: chrome.offscreen.CreateParameters = {
	url: "pages/offscreen.html",
	reasons: ["WORKERS"],
	justification: "Runs the Stockfish WebAssembly engine",
};

describe("chrome.offscreen fake", () => {
	it("enforces the single-document rule and reports through hasDocument/getContexts", async () => {
		expect(await sim.chrome.offscreen.hasDocument()).toBe(false);
		await sim.chrome.offscreen.createDocument(params);
		expect(sim.offscreen.document()).toMatchObject({
			url: "pages/offscreen.html",
			reasons: ["WORKERS"],
		});
		expect(await sim.chrome.offscreen.hasDocument()).toBe(true);
		let err: string | undefined;
		sim.chrome.offscreen.createDocument(params, () => {
			err = chrome.runtime.lastError?.message;
		});
		expect(err).toBe(SINGLE_DOCUMENT_ERROR);
		await expect(sim.chrome.offscreen.createDocument(params)).rejects.toThrow(SINGLE_DOCUMENT_ERROR);
		const contexts = await sim.chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
		expect(contexts).toHaveLength(1);
		await sim.chrome.offscreen.closeDocument();
		expect(await sim.chrome.offscreen.hasDocument()).toBe(false);
		await expect(sim.chrome.offscreen.closeDocument()).rejects.toThrow(NO_DOCUMENT_ERROR);
		expect(await sim.chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).toEqual(
			[]
		);
		expect(sim.offscreen.history()).toHaveLength(1);
	});

	it("works with the offscreenEnsure / offscreenClose wrappers", async () => {
		expect(await offscreenEnsure(params)).toBe(true);
		expect(await offscreenEnsure(params)).toBe(false);
		await offscreenClose();
		expect(sim.offscreen.hasDocument()).toBe(false);
		await expect(offscreenClose()).rejects.toThrow(NO_DOCUMENT_ERROR);
	});
});
