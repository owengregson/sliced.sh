// test/sim/scripting.test.ts
import { describe, expect, it } from "bun:test";
import { createSimulator } from "@test/sim";

describe("chrome.scripting fake", () => {
	it("records injections and answers with the stub or a scripted responder", async () => {
		const sim = createSimulator();
		const injection = { target: { tabId: 1 }, func: () => 42 };
		expect(await sim.scripting.api.executeScript(injection)).toEqual([
			{ frameId: 0, documentId: "sim-doc", result: undefined },
		]);
		sim.scripting.respond((inj) => [{ frameId: 0, documentId: "d", result: inj.target.tabId }]);
		const viaCb = await new Promise<unknown>((r) =>
			sim.chrome.scripting.executeScript({ target: { tabId: 7 }, files: ["x.js"] }, r)
		);
		expect(viaCb).toEqual([{ frameId: 0, documentId: "d", result: 7 }]);
		expect(sim.scripting.injections).toHaveLength(2);
	});
});
