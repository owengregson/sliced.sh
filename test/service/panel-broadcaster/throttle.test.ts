// test/service/panel-broadcaster/throttle.test.ts — the snapshot throttle: an idle request runs at
// once, a burst inside the interval collapses into one trailing run, and cancel drops it.
import { describe, expect, it } from "bun:test";
import type { Scheduler } from "@core/util/scheduler";
import { TrailingThrottle } from "@service/panel-broadcaster/throttle";

function fakeScheduler() {
	let clock = 0;
	let nextId = 1;
	const timers = new Map<number, { fn: () => void; at: number }>();
	const scheduler = {
		setTimeout(fn: () => void, ms: number) {
			const id = nextId++;
			timers.set(id, { fn, at: clock + ms });
			return id;
		},
		clearTimeout(handle: unknown) {
			timers.delete(handle as number);
		},
	} as unknown as Scheduler;
	return {
		scheduler,
		now: () => clock,
		pending: () => timers.size,
		advance(ms: number) {
			clock += ms;
			for (const [id, t] of [...timers]) {
				if (t.at > clock) continue;
				timers.delete(id);
				t.fn();
			}
		},
	};
}

describe("TrailingThrottle", () => {
	it("runs an idle request at once and a burst once at the end of the interval", () => {
		const clock = fakeScheduler();
		let runs = 0;
		const throttle = new TrailingThrottle(clock.scheduler, clock.now, 100, () => {
			runs += 1;
		});
		throttle.request();
		expect(runs).toBe(1);
		clock.advance(10);
		throttle.request();
		throttle.request();
		expect(runs).toBe(1);
		expect(clock.pending()).toBe(1);
		clock.advance(90);
		expect(runs).toBe(2);
	});

	it("drops a scheduled trailing run on cancel", () => {
		const clock = fakeScheduler();
		let runs = 0;
		const throttle = new TrailingThrottle(clock.scheduler, clock.now, 100, () => {
			runs += 1;
		});
		throttle.request();
		throttle.request();
		throttle.cancel();
		clock.advance(200);
		expect(runs).toBe(1);
		expect(clock.pending()).toBe(0);
	});
});
