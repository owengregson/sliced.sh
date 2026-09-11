import { afterEach, beforeEach, expect, it } from "bun:test";
import { type ClockHandle, createClock } from "@panel/components/clock";
import { bootPanelDom, type PanelDom } from "../dom";

let dom: PanelDom;
let clock: ClockHandle;
beforeEach(async () => {
	dom = await bootPanelDom();
	clock = createClock(document.body);
});
afterEach(async () => {
	clock.dispose();
	await dom.teardown();
});
const time = () => clock.el.querySelector(".sl-clock__time")?.textContent;
const tenths = () => clock.el.querySelector(".sl-clock__tenths")?.textContent;

it("counts down from site capture time across duplicate snapshots and corrects to new readings", async () => {
	const reading = { ms: 60_000, active: true, running: true, at: Date.now() - 500 };
	clock.update(reading);
	expect(time()).toBe("00:59");
	await dom.tick(1600);
	expect(time()).toBe("00:57");
	clock.update(reading);
	expect(time()).toBe("00:57");
	await dom.tick(1000);
	expect(time()).toBe("00:56");
	clock.update({ ms: 62_000, active: false, running: false, at: Date.now() });
	await dom.tick(4000);
	expect(time()).toBe("01:02"); // Increment and turn change stop extrapolation.
});

it("ticks tenths, clamps zero, and clears its interval for unknown clocks or disposal", async () => {
	const timers = dom.sim.time.pendingTimers();
	clock.update({ ms: 900, active: true, running: true, at: Date.now() });
	await dom.tick(300);
	expect(time()).toBe("0");
	expect(tenths()).toBe(".6");
	await dom.tick(1000);
	expect(time()).toBe("0");
	expect(tenths()).toBe(".0");
	clock.update({ ms: null });
	expect(dom.sim.time.pendingTimers()).toBe(timers);
	expect(clock.el.dataset.state).toBe("unknown");
	clock.update({ ms: 5000, running: true });
	clock.dispose();
	expect(dom.sim.time.pendingTimers()).toBe(timers);
});
