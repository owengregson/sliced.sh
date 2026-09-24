import { describe, expect, it } from "bun:test";
import type { Scheduler } from "@core/util/scheduler";
import { ScrambleHold } from "@service/move-executor/executor/scramble-hold";

function fakeScheduler(): Scheduler & { fire(): void; live: number } {
	const timers = new Map<number, () => void>();
	let next = 0;
	return {
		setTimeout(fn) {
			timers.set(++next, fn);
			return next;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
		fire() {
			for (const [id, fn] of [...timers]) {
				timers.delete(id);
				fn();
			}
		},
		get live() {
			return timers.size;
		},
	};
}

describe("ScrambleHold", () => {
	it("is decided once, and the decision clears the timeout", async () => {
		const scheduler = fakeScheduler();
		const hold = new ScrambleHold(scheduler, 5000, { tabId: 1, uci: "e2e4" });
		expect(scheduler.live).toBe(1);
		hold.handle.resolve("release");
		hold.handle.resolve("abandon");
		expect(hold.handle.decided).toBe(true);
		expect(scheduler.live).toBe(0);
		expect(await hold.directive.decide()).toBe("release");
	});

	it("gives the piece back when the opponent never answers", async () => {
		const scheduler = fakeScheduler();
		const hold = new ScrambleHold(scheduler, 5000, { tabId: 1, uci: "e2e4" });
		scheduler.fire();
		expect(hold.handle.decided).toBe(true);
		expect(await hold.directive.decide()).toBe("abandon");
	});

	it("never outlives its execution", () => {
		const scheduler = fakeScheduler();
		const hold = new ScrambleHold(scheduler, 5000, { tabId: 1, uci: "e2e4" });
		hold.dispose();
		expect(scheduler.live).toBe(0);
	});
});
