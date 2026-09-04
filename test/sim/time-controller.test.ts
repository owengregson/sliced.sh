// test/sim/time-controller.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSimulator, type Simulator } from "@test/sim";
import { createTimeController } from "@test/sim/time/time-controller";

let sim: Simulator;
beforeEach(() => {
	sim = createSimulator({ startAt: 1_000_000 });
});
afterEach(() => sim.time.uninstall());

describe("time controller", () => {
	it("now() only moves through advance/setNow and reports performance.now relative to the origin", async () => {
		expect(sim.now()).toBe(1_000_000);
		await sim.time.advance(250);
		expect(sim.now()).toBe(1_000_250);
		expect(sim.time.performanceNow()).toBe(250);
		sim.time.setNow(2_000_000);
		expect(sim.now()).toBe(2_000_000);
		await expect(sim.time.advance(-1)).rejects.toThrow();
	});

	it("install() fakes setTimeout/setInterval/Date.now/performance.now until uninstall()", async () => {
		const realSetTimeout = globalThis.setTimeout;
		sim.time.install();
		expect(sim.time.installed).toBe(true);
		expect(Date.now()).toBe(1_000_000);
		expect(performance.now()).toBe(0);
		const log: string[] = [];
		const id = setTimeout(() => log.push("never"), 100);
		clearTimeout(id);
		setTimeout(() => log.push(`t50@${performance.now()}`), 50);
		const iv = setInterval(() => log.push(`iv@${Date.now()}`), 30);
		expect(sim.time.pendingTimers()).toBe(2);
		await sim.time.advance(100);
		clearInterval(iv);
		expect(log).toEqual(["iv@1000030", "t50@50", "iv@1000060", "iv@1000090"]);
		sim.time.uninstall();
		expect(globalThis.setTimeout).toBe(realSetTimeout);
		expect(sim.time.pendingTimers()).toBe(0);
	});

	it("fires timers and alarms strictly in due order, draining microtasks so await-chains progress", async () => {
		sim.time.install();
		const order: string[] = [];
		const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
		sim.chrome.alarms.onAlarm.addListener((a) => void order.push(`alarm:${a.name}@${sim.now()}`));
		sim.chrome.alarms.create("mid", { when: 1_000_020 });
		const chain = (async () => {
			await sleep(10);
			order.push(`a@${performance.now()}`);
			await sleep(10);
			order.push(`b@${performance.now()}`);
			await sleep(10);
			order.push(`c@${performance.now()}`);
		})();
		setTimeout(() => order.push(`z@${performance.now()}`), 20);
		await sim.time.advance(35);
		await chain;
		expect(order).toEqual(["a@10", "z@20", "b@20", "alarm:mid@1000020", "c@30"]);
	});

	it("flush() runs everything already due; advanceUntilIdle() runs until no timer is pending", async () => {
		sim.time.install();
		const log: number[] = [];
		setTimeout(() => log.push(1), 0);
		setTimeout(() => setTimeout(() => log.push(2), 0), 0);
		await sim.time.flush();
		expect(log).toEqual([1, 2]);
		expect(sim.now()).toBe(1_000_000);
		setTimeout(() => setTimeout(() => log.push(3), 40), 15);
		await sim.time.advanceUntilIdle();
		expect(log).toEqual([1, 2, 3]);
		expect(sim.now()).toBe(1_000_055);
		expect(sim.time.nextDue()).toBeNull();
	});

	it("guards against runaway zero-delay loops", async () => {
		const time = createTimeController(0);
		time.install();
		try {
			const spin = (): void => void setTimeout(spin, 0);
			spin();
			await expect(time.advance(1)).rejects.toThrow(/too many timer steps/);
		} finally {
			time.uninstall();
		}
	});
});
