// test/sim/windows.test.ts
import { describe, expect, it } from "bun:test";
import { createSimulator } from "@test/sim";
import { WINDOW_ID_NONE } from "@test/sim/chrome/windows";
import { bootPanelContext } from "@test/sim/contexts/panel-context";

describe("chrome.windows fake", () => {
	it("setFocus fires onFocusChanged (including WINDOW_ID_NONE) and getters reflect it", async () => {
		const sim = createSimulator();
		const seen: number[] = [];
		sim.chrome.windows.onFocusChanged.addListener((id) => void seen.push(id));
		sim.windows.setFocus(WINDOW_ID_NONE);
		sim.windows.setFocus(1);
		expect(seen).toEqual([WINDOW_ID_NONE, 1]);
		expect(sim.chrome.windows.WINDOW_ID_NONE).toBe(-1);
		expect((await sim.chrome.windows.getLastFocused()).id).toBe(1);
		expect((await sim.chrome.windows.getCurrent()).focused).toBe(true);
		const viaCb = await new Promise<chrome.windows.Window>((r) => sim.chrome.windows.get(1, r));
		expect(viaCb.id).toBe(1);
	});

	it("getCurrent answers per calling page: a panel reports the window it was put in", async () => {
		const sim = createSimulator();
		const panel = await bootPanelContext(sim);
		expect((await panel.run(() => sim.chrome.windows.getCurrent())).id).toBe(1); // default
		sim.windows.setCurrent(panel.id, 2);
		expect((await panel.run(() => sim.chrome.windows.getCurrent())).id).toBe(2);
		const other = await bootPanelContext(sim); // a second page, still in the default window
		expect((await other.run(() => sim.chrome.windows.getCurrent())).id).toBe(1);
		await other.teardown();
		await panel.teardown();
		await sim.dispose();
	});
});
