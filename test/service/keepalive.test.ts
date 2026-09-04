// test/service/keepalive.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import { ALARM_CADENCE_MINUTES, ALARM_NAMES } from "@core/constants";
import { Keepalive } from "@service/keepalive";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;
beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});

const keepaliveAlarms = () => sim.alarms.list().filter((a) => a.name === ALARM_NAMES.keepalive);

describe("Keepalive", () => {
	it("creates the 0.5 min alarm on the first hold and clears it on the last release", async () => {
		const k = new Keepalive();
		expect(k.isHeld()).toBe(false);
		await k.hold("game");
		expect(keepaliveAlarms()).toHaveLength(1);
		expect(keepaliveAlarms()[0]?.periodInMinutes).toBe(ALARM_CADENCE_MINUTES.keepalive);
		await k.hold("debugger");
		expect(keepaliveAlarms()).toHaveLength(1);
		expect(k.reasons()).toEqual(["game", "debugger"]);
		await k.release("game");
		expect(keepaliveAlarms()).toHaveLength(1);
		expect(k.isHeld()).toBe(true);
		await k.release("debugger");
		expect(keepaliveAlarms()).toHaveLength(0);
		expect(k.isHeld()).toBe(false);
	});
	it("holding the same reason twice and releasing an unknown reason are no-ops", async () => {
		const k = new Keepalive();
		await k.hold("game");
		await k.hold("game");
		expect(k.reasons()).toEqual(["game"]);
		await k.release("nope");
		expect(keepaliveAlarms()).toHaveLength(1);
		await k.release("game");
		expect(keepaliveAlarms()).toHaveLength(0);
	});
	it("serialises interleaved hold/release so the alarm state matches the final reason set", async () => {
		const k = new Keepalive();
		await Promise.all([k.hold("a"), k.release("a"), k.hold("b")]);
		expect(keepaliveAlarms()).toHaveLength(1);
		expect(k.reasons()).toEqual(["b"]);
		await Promise.all([k.hold("c"), k.release("b"), k.release("c")]);
		expect(keepaliveAlarms()).toHaveLength(0);
	});
	it("the alarm fires while held and the handler is a harmless wake-up", async () => {
		const k = new Keepalive();
		await k.hold("game");
		await sim.time.advance(ALARM_CADENCE_MINUTES.keepalive * 60_000 * 2);
		const fired = sim.alarms.fired().filter((a) => a.name === ALARM_NAMES.keepalive);
		expect(fired).toHaveLength(2);
		expect(() => k.onAlarm()).not.toThrow();
	});
	it("an orphaned alarm (SW restarted, reasons lost) is cleared on its next tick", async () => {
		const before = new Keepalive();
		await before.hold("game");
		expect(keepaliveAlarms()).toHaveLength(1);
		// SW eviction: in-memory reasons vanish, chrome.alarms persists.
		const after = new Keepalive();
		await sim.time.advance(ALARM_CADENCE_MINUTES.keepalive * 60_000);
		expect(sim.alarms.fired().filter((a) => a.name === ALARM_NAMES.keepalive)).toHaveLength(1);
		after.onAlarm(); // what the lifecycle dispatcher calls
		await sim.time.runMicrotasks();
		expect(keepaliveAlarms()).toHaveLength(0);
		// a tick while held leaves the alarm alone
		await after.hold("debugger");
		after.onAlarm();
		await sim.time.runMicrotasks();
		expect(keepaliveAlarms()).toHaveLength(1);
	});
	it("dispose releases every reason and clears the alarm", async () => {
		const k = new Keepalive();
		await k.hold("game");
		await k.hold("debugger");
		await k.dispose();
		expect(k.isHeld()).toBe(false);
		expect(keepaliveAlarms()).toHaveLength(0);
	});
});
