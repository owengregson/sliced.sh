// test/sim/chrome/alarms.ts
/**
 * `chrome.alarms` driven by the virtual clock. `create` replaces an alarm of
 * the same name; a periodic alarm re-arms from its previous `scheduledTime`
 * (so a big `advance` fires every missed period); one-shots are removed
 * after firing. Chrome's minimum cadence (30 s in Chrome 120+) is NOT
 * enforced so tests can use short periods.
 */

import type { Bus } from "@test/sim/contexts/bus";
import type { AlarmListener, AlarmRecord, TimerSource } from "@test/sim/types";

export function createAlarmsSubsystem(bus: Bus) {
	const alarms = new Map<string, AlarmRecord>();
	const onAlarm = bus.event<[chrome.alarms.Alarm]>();
	const fired: chrome.alarms.Alarm[] = [];

	const toApi = (a: AlarmRecord): chrome.alarms.Alarm =>
		a.periodInMinutes === undefined
			? { name: a.name, scheduledTime: a.scheduledTime }
			: { name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes };

	const scheduledTime = (info: chrome.alarms.AlarmCreateInfo): number => {
		if (info.when !== undefined) return info.when;
		if (info.delayInMinutes !== undefined) return bus.now() + info.delayInMinutes * 60_000;
		if (info.periodInMinutes !== undefined) return bus.now() + info.periodInMinutes * 60_000;
		return bus.now();
	};

	const api = {
		create(...args: unknown[]) {
			// (name, info, cb?) | (info, cb?)
			const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
			const name = typeof args[0] === "string" ? args[0] : "";
			const info = (typeof args[0] === "string" ? args[1] : args[0]) as
				| chrome.alarms.AlarmCreateInfo
				| undefined;
			const record: AlarmRecord = { name, scheduledTime: scheduledTime(info ?? {}) };
			if (info?.periodInMinutes !== undefined) record.periodInMinutes = info.periodInMinutes;
			alarms.set(name, record);
			return bus.settle(callback, undefined);
		},
		get(...args: unknown[]) {
			const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
			const name = typeof args[0] === "string" ? args[0] : "";
			const a = alarms.get(name);
			return bus.settle(callback, a ? toApi(a) : undefined);
		},
		getAll(callback?: (alarms: chrome.alarms.Alarm[]) => void) {
			return bus.settle(callback, [...alarms.values()].map(toApi));
		},
		clear(...args: unknown[]) {
			const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
			const name = typeof args[0] === "string" ? args[0] : "";
			return bus.settle(callback, alarms.delete(name));
		},
		clearAll(callback?: (wasCleared: boolean) => void) {
			const had = alarms.size > 0;
			alarms.clear();
			return bus.settle(callback, had);
		},
		onAlarm: {
			addListener: (l: AlarmListener) => onAlarm.addListener(l),
			removeListener: (l: AlarmListener) => onAlarm.removeListener(l),
			hasListener: (l: AlarmListener) => onAlarm.hasListener(l),
		},
	};

	const source: TimerSource = {
		nextDue() {
			let next: number | null = null;
			for (const a of alarms.values())
				if (next === null || a.scheduledTime < next) next = a.scheduledTime;
			return next;
		},
		fireDue(now) {
			const due = [...alarms.values()]
				.filter((a) => a.scheduledTime <= now)
				.sort((a, b) => a.scheduledTime - b.scheduledTime);
			for (const a of due) {
				const alarm = toApi(a);
				if (a.periodInMinutes !== undefined) a.scheduledTime += a.periodInMinutes * 60_000;
				else alarms.delete(a.name);
				fired.push(alarm);
				onAlarm.fire(alarm);
			}
			return due.length;
		},
	};

	return {
		api,
		source,
		list: (): AlarmRecord[] => [...alarms.values()].map((a) => ({ ...a })),
		/** Every alarm delivered so far, in order. */
		fired: (): chrome.alarms.Alarm[] => [...fired],
		/** Deliver alarms due at or before `now` (the time controller calls this). */
		fireDue: (now: number): number => source.fireDue(now),
	};
}

export type AlarmsSubsystem = ReturnType<typeof createAlarmsSubsystem>;
