// test/sim/side-panel.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sidePanelOpen, sidePanelSetBehavior, sidePanelSetOptions } from "@core/chrome/side-panel";
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

describe("chrome.sidePanel fake", () => {
	it("records per-tab and global options, behaviour, and open calls", async () => {
		await sidePanelSetBehavior({ openPanelOnActionClick: true });
		await sidePanelSetOptions({ tabId: 3, enabled: false });
		await sidePanelSetOptions({ tabId: 4, path: "pages/panel.html", enabled: true });
		await sidePanelSetOptions({ path: "pages/other.html" });
		expect(sim.sidePanel.state.behavior).toEqual({ openPanelOnActionClick: true });
		expect(sim.sidePanel.optionsFor(3)).toEqual({
			path: "pages/other.html",
			enabled: false,
			tabId: 3,
		});
		expect(sim.sidePanel.optionsFor(9)).toEqual({ path: "pages/other.html", enabled: true });
		expect(await sim.chrome.sidePanel.getOptions({ tabId: 4 })).toMatchObject({
			enabled: true,
			tabId: 4,
		});
		expect(await sim.chrome.sidePanel.getPanelBehavior()).toEqual({ openPanelOnActionClick: true });
		await sidePanelOpen({ tabId: 3 });
		expect(sim.sidePanel.state.opens.map((o) => o.options)).toEqual([{ tabId: 3 }]);
		await expect(sidePanelOpen({} as chrome.sidePanel.OpenOptions)).rejects.toThrow(
			"At least one of tabId and windowId"
		);
	});
});
