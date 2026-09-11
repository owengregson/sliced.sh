import { beforeEach, describe, expect, it } from "bun:test";
import { onAlarm } from "@core/chrome/alarms";
import { ALARM_NAMES } from "@core/constants/alarms";
import { SESSION_KEYS } from "@core/constants/storage-keys";
import {
	createAutoQueuePersistence,
	type PendingAutoQueues,
} from "@service/auto-queue-persistence";
import { createSimulator, type Simulator } from "@test/sim";
import { bootSwContext } from "@test/sim/contexts/sw-context";

let sim: Simulator;
beforeEach(() => {
	sim = createSimulator({ startAt: 1000000 });
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});

const pending = (gameId: string | null, dueAt: number) => ({ gameId, dueAt });

describe("durable autoqueue persistence", () => {
	it("persists independent tabs and keeps exactly the earliest deadline alarm", async () => {
		const store = createAutoQueuePersistence();
		const records = { "7": pending("game-a", 1200000), "9": pending(null, 1100000) };
		await store.save(records);
		expect(await store.load()).toEqual(records);
		expect(sim.alarms.list()).toEqual([{ name: ALARM_NAMES.autoQueue, scheduledTime: 1100000 }]);
		await store.save({ "7": records["7"] });
		expect(sim.alarms.list()).toEqual([{ name: ALARM_NAMES.autoQueue, scheduledTime: 1200000 }]);
		await store.save({});
		expect(await store.load()).toEqual({});
		expect(sim.alarms.list()).toEqual([]);
	});

	it("persists active session progress without an alarm, then wakes for its break", async () => {
		const store = createAutoQueuePersistence();
		const session = {
			gameId: "second",
			startedAt: 900000,
			endsAt: 1300000,
			completedGames: 1,
			lastFinishedGameId: "first",
			breakUntil: null,
		};
		const active = { "4": { gameId: "second", dueAt: null, session } };
		await store.save(active);
		expect(await store.load()).toEqual(active);
		expect(sim.alarms.list()).toEqual([]);
		const takingBreak = {
			"4": {
				gameId: "second",
				dueAt: 1600000,
				session: { ...session, completedGames: 2, lastFinishedGameId: "second", breakUntil: 1600000 },
			},
		};
		await store.save(takingBreak);
		expect(await store.load()).toEqual(takingBreak);
		expect(sim.alarms.list()).toEqual([{ name: ALARM_NAMES.autoQueue, scheduledTime: 1600000 }]);
	});

	it("rejects malformed active sessions without losing valid pending queue recovery", async () => {
		const session = {
			gameId: "first",
			startedAt: 900000,
			endsAt: 1300000,
			completedGames: 0,
			lastFinishedGameId: null,
			breakUntil: null,
		};
		for (const malformed of [
			null,
			[],
			{ ...session, endsAt: 800000 },
			{ ...session, completedGames: -1 },
			{ ...session, breakUntil: 1200000 },
			{ ...session, startedAt: Number.NaN },
			{ ...session, gameId: 3 },
		]) {
			const store = createAutoQueuePersistence({
				read: async () => ({
					"1": { gameId: "first", dueAt: null, session: malformed },
					"2": { gameId: "first", dueAt: 1600000, session: malformed },
				}),
			});
			expect(await store.load()).toEqual({ "2": pending("first", 1600000) });
		}
	});

	it("restores saved state and receives its alarm after the worker terminates and reboots", async () => {
		const first = await bootSwContext(sim);
		const records = { "4": pending("finished-game", sim.now() + 60000) };
		await first.run(() => createAutoQueuePersistence().save(records));
		await first.teardown();
		expect(sim.alarms.list()).toHaveLength(1);
		let restored: PendingAutoQueues = {};
		const fired: number[] = [];
		const second = await bootSwContext(sim, {
			entry: () => {
				const store = createAutoQueuePersistence();
				// Register synchronously, before storage is awaited, as the real entrypoint must.
				onAlarm((alarm) => {
					if (alarm.name === ALARM_NAMES.autoQueue) fired.push(sim.now());
				});
				return store.load().then((records) => {
					restored = records;
				});
			},
		});
		expect(restored).toEqual(records);
		await sim.time.advance(60000);
		expect(fired).toEqual([1060000]);
		await second.teardown();
	});

	it("repairs a lost wake alarm on load, retaining an overdue record for immediate processing", async () => {
		await sim.chrome.storage.session.set({
			[SESSION_KEYS.autoQueuePending]: { "3": pending("old", 999000) },
		});
		const store = createAutoQueuePersistence();
		expect(await store.load()).toEqual({ "3": pending("old", 999000) });
		expect(sim.alarms.list()).toEqual([{ name: ALARM_NAMES.autoQueue, scheduledTime: 999000 }]);
	});

	it("filters malformed ids and deadlines and strips unknown fields without mutating valid records", async () => {
		const raw = {
			"0": { gameId: null, dueAt: 123.5, unknown: "discard" },
			"1": { gameId: "ok", dueAt: 2000000 },
			"2": { gameId: 7, dueAt: 2000000 },
			"3": { gameId: "bad", dueAt: Number.NaN },
			"4": { gameId: "bad", dueAt: Number.POSITIVE_INFINITY },
			"5": { gameId: "bad", dueAt: -1 },
			"6": { gameId: "bad", dueAt: "2000000" },
			"7": { gameId: "bad", dueAt: Number.MAX_VALUE },
			"8": [],
			"-1": pending("bad", 1000),
			"01": pending("bad", 1000),
			"1.5": pending("bad", 1000),
			constructor: pending("bad", 1000),
		};
		const store = createAutoQueuePersistence({ read: async () => raw });
		const loaded = await store.load();
		expect(loaded).toEqual({ "0": pending(null, 123.5), "1": pending("ok", 2000000) });
		loaded["1"]!.dueAt = 42;
		expect(raw["1"].dueAt).toBe(2000000);
		for (const malformed of [null, [], "bad", 1]) {
			expect(await createAutoQueuePersistence({ read: async () => malformed }).load()).toEqual({});
		}
		expect(sim.alarms.list()).toEqual([]);
	});

	it("captures snapshots when called and serializes writes plus alarms in call order", async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const events: string[] = [];
		const store = createAutoQueuePersistence({
			write: async (records) => {
				const due = records["1"]?.dueAt;
				events.push(`write:${due}`);
				if (due === 1100000) await held;
			},
			getAlarm: async () => null,
			setAlarm: async (when) => {
				events.push(`alarm:${when}`);
			},
		});
		const records = { "1": pending("a", 1100000) };
		const first = store.save(records);
		records["1"].dueAt = 1300000;
		const second = store.save({ "1": pending("b", 1200000) });
		await Promise.resolve();
		expect(events).toEqual(["write:1100000"]);
		release();
		await Promise.all([first, second]);
		expect(events).toEqual(["write:1100000", "alarm:1100000", "write:1200000", "alarm:1200000"]);
	});

	it("surfaces storage errors without changing the wake alarm or poisoning the next save", async () => {
		const store = createAutoQueuePersistence();
		await store.save({ "1": pending("a", 1100000) });
		sim.storage.failNextWith("storage unavailable");
		await expect(store.save({ "1": pending("b", 1200000) })).rejects.toThrow("storage unavailable");
		expect(sim.alarms.list()[0]?.scheduledTime).toBe(1100000);
		await store.save({ "1": pending("c", 1300000) });
		expect(await store.load()).toEqual({ "1": pending("c", 1300000) });
	});

	it("leaves persisted records recoverable when alarm creation fails", async () => {
		const records = { "1": pending("a", 1100000) };
		const store = createAutoQueuePersistence({
			setAlarm: async () => {
				throw new Error("alarm failed");
			},
		});
		await expect(store.save(records)).rejects.toThrow("alarm failed");
		expect(await createAutoQueuePersistence().load()).toEqual(records);
		expect(sim.alarms.list()[0]?.scheduledTime).toBe(1100000);
	});

	it("load waits for an in-flight save and never replaces its alarm with stale state", async () => {
		const store = createAutoQueuePersistence();
		const records = { "1": pending("a", 1100000) };
		const saving = store.save(records);
		const loading = store.load();
		await saving;
		expect(await loading).toEqual(records);
		expect(sim.alarms.list()[0]?.scheduledTime).toBe(1100000);
	});
});
