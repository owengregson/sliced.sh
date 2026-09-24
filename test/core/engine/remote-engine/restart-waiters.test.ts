// test/core/engine/remote-engine/restart-waiters.test.ts
import { describe, expect, it } from "bun:test";
import { RestartWaiters } from "@core/engine/remote-engine/restart-waiters";

function fakeScheduler() {
	const timers = new Map<number, () => void>();
	let next = 0;
	return {
		timers,
		scheduler: {
			setTimeout: (fn: () => void) => {
				next += 1;
				timers.set(next, fn);
				return next;
			},
			clearTimeout: (handle: unknown) => void timers.delete(handle as number),
		},
	};
}

describe("RestartWaiters", () => {
	it("ignores a stale ready and settles on the ready after a non-ready status", async () => {
		const { scheduler, timers } = fakeScheduler();
		const waiters = new RestartWaiters(scheduler, 1000);
		let posted = 0;
		let settled = false;
		const p = waiters
			.wait(() => posted++)
			.then(() => {
				settled = true;
			});
		expect(posted).toBe(1);
		waiters.observe("ready");
		await Promise.resolve();
		expect(settled).toBe(false);
		waiters.observe("booting");
		waiters.observe("ready");
		await p;
		expect(timers.size).toBe(0);
	});

	it("rejects on timeout and on rejectAll", async () => {
		const { scheduler, timers } = fakeScheduler();
		const waiters = new RestartWaiters(scheduler, 1000);
		const timedOut = waiters.wait(() => {});
		for (const fn of timers.values()) fn();
		await expect(timedOut).rejects.toThrow(/timed out/);
		const dropped = waiters.wait(() => {});
		waiters.rejectAll(new Error("disposed"));
		await expect(dropped).rejects.toThrow("disposed");
	});
});
