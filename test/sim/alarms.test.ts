// test/sim/alarms.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;
beforeEach(() => {
	sim = createSimulator({ startAt: 1_000_000 });
});

describe("chrome.alarms fake", () => {
	it("create/get/getAll/clear/clearAll in callback and Promise form", async () => {
		await new Promise<void>((r) =>
			sim.chrome.alarms.create("sl-keepalive", { periodInMinutes: 0.5 }, r)
		);
		sim.chrome.alarms.create("sl-license", { delayInMinutes: 1 });
		sim.chrome.alarms.create({ when: 1_500_000 });
		const keepalive = await sim.chrome.alarms.get("sl-keepalive");
		expect(keepalive).toEqual({
			name: "sl-keepalive",
			scheduledTime: 1_030_000,
			periodInMinutes: 0.5,
		});
		const viaCb = await new Promise<chrome.alarms.Alarm | undefined>((r) =>
			sim.chrome.alarms.get("sl-license", r)
		);
		expect(viaCb).toEqual({ name: "sl-license", scheduledTime: 1_060_000 });
		expect(await sim.chrome.alarms.get("missing")).toBeUndefined();
		expect((await sim.chrome.alarms.getAll()).map((a) => a.name)).toEqual([
			"sl-keepalive",
			"sl-license",
			"",
		]);
		expect(await sim.chrome.alarms.clear("sl-license")).toBe(true);
		expect(await sim.chrome.alarms.clear("sl-license")).toBe(false);
		expect(await sim.chrome.alarms.clearAll()).toBe(true);
		expect(await sim.chrome.alarms.clearAll()).toBe(false);
	});

	it("create with an existing name replaces the alarm", async () => {
		sim.chrome.alarms.create("a", { delayInMinutes: 1 });
		sim.chrome.alarms.create("a", { delayInMinutes: 2 });
		expect((await sim.chrome.alarms.getAll()).map((a) => a.scheduledTime)).toEqual([1_120_000]);
	});

	it("onAlarm is driven by the time controller: one-shots fire once, periodic alarms re-arm from the previous schedule", async () => {
		const fired: string[] = [];
		sim.chrome.alarms.onAlarm.addListener((a) => void fired.push(`${a.name}@${sim.now()}`));
		sim.chrome.alarms.create("once", { when: 1_005_000 });
		sim.chrome.alarms.create("tick", { periodInMinutes: 1 });
		await sim.time.advance(4_000);
		expect(fired).toEqual([]);
		await sim.time.advance(1_000);
		expect(fired).toEqual(["once@1005000"]);
		await sim.time.advance(180_000);
		expect(fired).toEqual(["once@1005000", "tick@1060000", "tick@1120000", "tick@1180000"]);
		expect(sim.alarms.list().map((a) => a.name)).toEqual(["tick"]);
		expect(sim.alarms.fired()).toHaveLength(4);
		sim.chrome.alarms.clear("tick");
		await sim.time.advance(600_000);
		expect(fired).toHaveLength(4);
	});
});
