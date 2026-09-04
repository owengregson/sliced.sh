// test/sim/commands.test.ts
import { describe, expect, it } from "bun:test";
import { createSimulator } from "@test/sim";

describe("chrome.commands fake", () => {
	it("trigger(command, tab?) fires onCommand listeners", async () => {
		const sim = createSimulator();
		const seen: Array<[string, number | undefined]> = [];
		sim.chrome.commands.onCommand.addListener((c, tab) => void seen.push([c, tab?.id]));
		const tab = sim.tabs.toApi(sim.openTab("https://www.chess.com/").tabId);
		sim.commands.trigger("play-move");
		sim.commands.trigger("toggle-auto-move", tab);
		expect(seen).toEqual([
			["play-move", undefined],
			["toggle-auto-move", tab?.id],
		]);
		expect(sim.commands.triggered()).toEqual(["play-move", "toggle-auto-move"]);
		expect(await sim.chrome.commands.getAll()).toEqual([]);
	});
});
