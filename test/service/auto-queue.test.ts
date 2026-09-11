import { describe, expect, it } from "bun:test";
import { TIMINGS } from "@core/constants/timings";
import { createRng } from "@core/rng";
import { AutoQueue, type AutoQueueOptions } from "@service/auto-queue";
import type { ContentLink } from "@service/content-link";
import { DEFAULT_SETTINGS } from "@typedefs/settings";
import type { PendingAutoQueues } from "@typedefs/storage";

const automation = DEFAULT_SETTINGS.automation;
const flush = async () => {
	for (let n = 0; n < 12; n++) await Promise.resolve();
};
function harness(
	options: { rng?: number; persisted?: PendingAutoQueues; loadFailures?: number } = {}
) {
	let now = 1_000;
	let sequence = 0;
	let gate: "allow" | "hold" | "cancel" = "allow";
	const timers = new Map<number, { at: number; fn: () => void }>();
	const calls: Array<{ tabId: number; at: number }> = [];
	let answer: () => Promise<{
		kind: "startNewGameResult";
		id: string;
		status: "started" | "searching" | "not-ready" | "in-game";
	}> = async () => ({ kind: "startNewGameResult", id: "r", status: "not-ready" });
	let saved = options.persisted ?? {};
	let failures = options.loadFailures ?? 0;
	let loads = 0;
	const writes: PendingAutoQueues[] = [];
	const queue = new AutoQueue({
		now: () => now,
		rng: { ...createRng("queue-test"), next: () => options.rng ?? 0 },
		canQueue: () => gate,
		link: {
			request: ((tabId: number) => {
				calls.push({ tabId, at: now });
				return answer();
			}) as ContentLink["request"],
		},
		scheduler: {
			setTimeout(fn, ms) {
				const id = ++sequence;
				timers.set(id, { at: now + ms, fn });
				return id;
			},
			clearTimeout(handle) {
				timers.delete(handle as number);
			},
		},
		persistence: {
			load: async () => {
				loads += 1;
				if (failures-- > 0) throw new Error("temporary session storage failure");
				return structuredClone(saved);
			},
			save: async (value) => {
				saved = structuredClone(value);
				writes.push(saved);
			},
		},
	});
	return {
		queue,
		calls,
		writes,
		get loads() {
			return loads;
		},
		timers,
		get saved() {
			return saved;
		},
		set gate(value: typeof gate) {
			gate = value;
		},
		set answer(value: typeof answer) {
			answer = value;
		},
		async advance(ms: number) {
			await flush();
			const end = now + ms;
			for (;;) {
				const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > end) break;
				timers.delete(next[0]);
				now = next[1].at;
				next[1].fn();
				await flush();
			}
			now = end;
			await flush();
		},
	};
}

describe("auto queue recovery", () => {
	it("retries a missing control and keeps checking matchmaking until the next game", async () => {
		const h = harness();
		await h.queue.schedule(1, "old", automation);
		await h.advance(900);
		expect(h.calls).toHaveLength(1);
		expect(h.queue.view(1)?.status).toBe("retrying");
		h.answer = async () => ({ kind: "startNewGameResult", id: "r", status: "started" });
		await h.advance(TIMINGS.autoQueueRetryMs);
		expect(h.calls).toHaveLength(2);
		expect(h.queue.view(1)?.status).toBe("searching");
		h.answer = async () => ({ kind: "startNewGameResult", id: "r", status: "searching" });
		await h.advance(TIMINGS.autoQueueSearchPollMs);
		expect(h.calls).toHaveLength(3);
		await h.queue.observedGame(1, "next");
		await h.advance(60_000);
		expect(h.calls).toHaveLength(3);
		expect(h.saved).toEqual({});
		h.queue.dispose();
	});

	it("retries rejected transport requests without an unhandled rejection", async () => {
		const h = harness();
		h.answer = async () => {
			throw new Error("port disconnected");
		};
		await h.queue.schedule(1, "old", automation);
		await h.advance(900 + TIMINGS.autoQueueRetryMs);
		expect(h.calls).toHaveLength(2);
		expect(h.queue.isPending(1)).toBe(true);
		h.queue.dispose();
	});

	it.each([0, 0.5, 0.999])("samples a 1–3 minute wait once with rng %s", async (rng) => {
		const h = harness({ rng });
		await h.queue.schedule(1, "old", {
			...automation,
			autoQueueDelayEnabled: true,
			autoQueueDelayMaxMinutes: 3,
		});
		const due = 1_000 + 60_000 + rng * 120_000;
		expect(h.queue.view(1)?.dueAt).toBe(due);
		await h.advance(30_000);
		await h.queue.schedule(1, "old", automation);
		expect(h.queue.view(1)?.dueAt).toBe(due);
		await h.advance(due - 31_000 - 1);
		expect(h.calls).toHaveLength(0);
		await h.advance(1);
		expect(h.calls).toHaveLength(1);
		h.queue.dispose();
	});

	it("restores the persisted deadline without resampling on game-end replay", async () => {
		const h = harness({ persisted: { "1": { gameId: "old", dueAt: 91_000 } } });
		await h.queue.schedule(1, "old", automation);
		expect(h.queue.view(1)?.dueAt).toBe(91_000);
		await h.queue.observedGame(1, "old");
		await h.advance(89_999);
		expect(h.calls).toHaveLength(0);
		await h.advance(1);
		expect(h.calls).toHaveLength(1);
		h.queue.dispose();
	});

	it("retries hydration before any new schedule can overwrite another tab's persisted job", async () => {
		const persisted = { "7": { gameId: "saved-game", dueAt: 91000 } };
		const h = harness({ persisted, loadFailures: 1 });
		let ready = false;
		void h.queue.ready.then(() => {
			ready = true;
		});
		const scheduling = h.queue.schedule(1, "newly-finished", automation);
		await h.advance(TIMINGS.autoQueueRetryMs - 1);
		expect(ready).toBe(false);
		expect(h.loads).toBe(1);
		expect(h.writes).toEqual([]);
		expect(h.saved).toEqual(persisted);
		expect(h.calls).toEqual([]);
		await h.advance(1);
		await scheduling;
		expect(ready).toBe(true);
		expect(h.loads).toBe(2);
		expect(h.queue.view(7)?.dueAt).toBe(91000);
		expect(h.saved["7"]).toEqual(persisted["7"]);
		expect(h.saved["1"]?.gameId).toBe("newly-finished");
		expect(h.writes.every((write) => write["7"]?.gameId === "saved-game")).toBe(true);
		h.queue.dispose();
	});

	it("disabling cancels the deadline and persisted intent", async () => {
		const h = harness();
		await h.queue.schedule(1, "old", automation);
		h.gate = "cancel";
		await h.queue.wake();
		await h.advance(60_000);
		expect(h.calls).toHaveLength(0);
		expect(h.saved).toEqual({});
		h.queue.dispose();
	});

	it("a disconnected/unknown session holds instead of dropping the queue", async () => {
		const h = harness();
		await h.queue.schedule(1, "old", automation);
		h.gate = "hold";
		await h.advance(10_000);
		expect(h.calls).toHaveLength(0);
		expect(h.queue.isPending(1)).toBe(true);
		h.gate = "allow";
		await h.advance(2_000);
		expect(h.calls).toHaveLength(1);
		h.queue.dispose();
	});

	it("a late reply cannot resurrect a cancelled attempt", async () => {
		const h = harness();
		let resolve!: (value: Awaited<ReturnType<typeof h.answer>>) => void;
		h.answer = () =>
			new Promise((done) => {
				resolve = done;
			});
		await h.queue.schedule(1, "old", automation);
		await h.advance(900);
		h.queue.cancel(1);
		resolve({ kind: "startNewGameResult", id: "r", status: "started" });
		await h.advance(60_000);
		expect(h.calls).toHaveLength(1);
		expect(h.queue.isPending(1)).toBe(false);
		h.queue.dispose();
	});

	it("cancellation while storage is loading prevents restoration or a queued schedule", async () => {
		let resolve!: (value: PendingAutoQueues) => void;
		const saved: PendingAutoQueues[] = [];
		const queue = new AutoQueue({
			rng: { ...createRng("queue-test"), next: () => 0 },
			canQueue: () => "allow",
			link: {
				request: (() => {
					throw new Error("must not request");
				}) as ContentLink["request"],
			},
			persistence: {
				load: () =>
					new Promise((done) => {
						resolve = done;
					}),
				save: async (value) => {
					saved.push(value);
				},
			},
		} satisfies AutoQueueOptions);
		const schedule = queue.schedule(1, "old", automation);
		queue.cancel(1);
		resolve({ "1": { gameId: "old", dueAt: 99_000 } });
		await schedule;
		expect(queue.isPending(1)).toBe(false);
		expect(saved.at(-1)).toEqual({});
		queue.dispose();
	});
});
