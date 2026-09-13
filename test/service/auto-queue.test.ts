import { describe, expect, it } from "bun:test";
import { REMATCH } from "@core/constants/rematch";
import { TIMINGS } from "@core/constants/timings";
import { createRng } from "@core/rng";
import { AutoQueue, type AutoQueueOptions } from "@service/auto-queue";
import type { RematchResult, RematchRunHooks } from "@service/rematch";
import { DEFAULT_SETTINGS } from "@typedefs/settings";
import type { PendingAutoQueues } from "@typedefs/storage";

const automation = DEFAULT_SETTINGS.automation;
/** The queue on with the rematch step on: what `canQueue` admits in production. */
const REMATCHING = { ...automation, autoQueue: true, rematchTitled: true };
const flush = async () => {
	for (let n = 0; n < 12; n++) await Promise.resolve();
};
/** A scripted rematch step: records runs, answers from `outcome`, resolves on `gameStarted`. */
interface FakeRematchStep {
	runs: Array<{ tabId: number; gameId: string | null; at: number }>;
	incomingReads: number;
	outcome: RematchResult["outcome"] | "wait";
	incoming: boolean;
	waiting: boolean;
}
function harness(
	options: {
		rng?: number;
		persisted?: PendingAutoQueues;
		loadFailures?: number;
		rematch?: boolean;
		rematchAllowed?: () => boolean;
	} = {}
) {
	let now = 1_000;
	let sequence = 0;
	let gate: "allow" | "hold" | "cancel" = "allow";
	const timers = new Map<number, { at: number; fn: () => void }>();
	const calls: Array<{ tabId: number; at: number }> = [];
	const breaks: number[] = [];
	let resolveStarted: (() => void) | null = null;
	const rematch: FakeRematchStep = {
		runs: [],
		incomingReads: 0,
		outcome: "wait",
		incoming: false,
		waiting: false,
	};
	const step = {
		incoming: async () => {
			rematch.incomingReads += 1;
			return rematch.incoming;
		},
		gameStarted: () => resolveStarted?.(),
		run: (
			tabId: number,
			gameId: string | null,
			signal: AbortSignal,
			hooks: RematchRunHooks = {}
		): Promise<RematchResult> => {
			rematch.runs.push({ tabId, gameId, at: now });
			if (rematch.outcome !== "wait")
				return Promise.resolve({
					outcome: rematch.outcome,
					clicked: rematch.outcome === "expired",
				});
			hooks.onClicked?.();
			rematch.waiting = true;
			return new Promise<RematchResult>((resolve) => {
				const finish = (outcome: RematchResult["outcome"]) => {
					rematch.waiting = false;
					resolveStarted = null;
					resolve({ outcome, clicked: true });
				};
				resolveStarted = () => finish("started");
				signal.addEventListener("abort", () => finish("aborted"), { once: true });
			});
		},
	};
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
		attempt: (tabId: number) => {
			calls.push({ tabId, at: now });
			return answer();
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
		...(options.rematch
			? {
					rematch: { step, allowed: options.rematchAllowed ?? (() => true) },
					onBreak: (tabId: number) => breaks.push(tabId),
				}
			: {}),
	});
	return {
		queue,
		calls,
		writes,
		rematch,
		breaks,
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
		expect(h.saved["1"]?.dueAt).toBeNull();
		expect(h.saved["1"]?.session?.gameId).toBe("next");
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

	it.each([0, 0.5, 0.999])(
		"samples one break after a completed session with rng %s",
		async (rng) => {
			const h = harness({ rng });
			const settings = {
				...automation,
				autoQueue: true,
				autoQueueSessionMinMinutes: 1,
				autoQueueSessionMaxMinutes: 1,
				autoQueueBreakMinMinutes: 1,
				autoQueueBreakMaxMinutes: 3,
			};
			await h.queue.observedGame(1, "old", settings);
			await h.advance(60_000);
			expect(h.calls).toHaveLength(0);
			expect(h.queue.isPending(1)).toBe(false);
			await h.queue.schedule(1, "old", settings);
			const due = 61_000 + 60_000 + rng * 120_000;
			expect(h.queue.view(1)?.status).toBe("break");
			expect(h.queue.view(1)?.dueAt).toBe(due);
			await h.advance(30_000);
			await h.queue.schedule(1, "old", automation);
			expect(h.queue.view(1)?.dueAt).toBe(due);
			await h.advance(due - 91_000 - 1);
			expect(h.calls).toHaveLength(0);
			await h.advance(1);
			expect(h.calls).toHaveLength(1);
			h.queue.dispose();
		}
	);

	it("queues consecutive games promptly and starts a fresh session only after the break", async () => {
		const h = harness();
		const settings = {
			...automation,
			autoQueue: true,
			autoQueueSessionMinMinutes: 2,
			autoQueueSessionMaxMinutes: 2,
			autoQueueBreakMinMinutes: 1,
			autoQueueBreakMaxMinutes: 1,
		};
		await h.queue.observedGame(1, "first", settings);
		const firstEnds = h.saved["1"]!.session!.endsAt;
		await h.advance(30_000);
		await h.queue.schedule(1, "first", settings);
		expect(h.queue.view(1)?.status).toBe("waiting");
		expect(h.queue.view(1)?.dueAt).toBe(31_900);
		await h.advance(900);
		await h.queue.observedGame(1, "second", settings);
		expect(h.saved["1"]?.session?.endsAt).toBe(firstEnds);
		expect(h.saved["1"]?.session?.completedGames).toBe(1);
		await h.advance(100_000);
		expect(h.calls).toHaveLength(1);
		await h.queue.schedule(1, "second", settings);
		expect(h.queue.view(1)?.status).toBe("break");
		expect(h.saved["1"]?.session?.completedGames).toBe(2);
		await h.advance(60_000);
		expect(h.calls).toHaveLength(2);
		await h.queue.observedGame(1, "third", settings);
		expect(h.saved["1"]?.session?.completedGames).toBe(0);
		expect(h.saved["1"]?.session?.breakUntil).toBeNull();
		expect(h.saved["1"]?.session?.endsAt).toBe(311_900);
		h.queue.dispose();
	});

	it("restores active sessions and breaks without resampling either deadline", async () => {
		const settings = {
			...automation,
			autoQueue: true,
			autoQueueSessionMinMinutes: 1,
			autoQueueSessionMaxMinutes: 1,
			autoQueueBreakMinMinutes: 2,
			autoQueueBreakMaxMinutes: 2,
		};
		const first = harness();
		await first.queue.observedGame(1, "first", settings);
		const active = structuredClone(first.saved);
		first.queue.dispose();
		const second = harness({ persisted: active, rng: 0.999 });
		await second.queue.observedGame(1, "first", settings);
		expect(second.saved).toEqual(active);
		await second.advance(90_000);
		await second.queue.schedule(1, "first", settings);
		const pending = structuredClone(second.saved);
		second.queue.dispose();
		const third = harness({ persisted: pending, rng: 0.5 });
		await third.queue.schedule(1, "first", settings);
		expect(third.saved).toEqual(pending);
		expect(third.queue.view(1)?.status).toBe("break");
		await third.advance(pending["1"]!.dueAt! - 1_000 - 1);
		expect(third.calls).toHaveLength(0);
		await third.advance(1);
		expect(third.calls).toHaveLength(1);
		third.queue.dispose();
	});

	it("explicit stop clears both the active session and pending break", async () => {
		const h = harness();
		await h.queue.observedGame(1, "old", { ...automation, autoQueue: true });
		expect(h.queue.isTracking(1)).toBe(true);
		h.queue.cancel(1);
		await flush();
		expect(h.saved).toEqual({});
		expect(h.queue.isTracking(1)).toBe(false);
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

	it("a titled opponent runs the rematch step after the ordinary delay, marks the opponent at the press, and the next game ends it", async () => {
		const h = harness({ rematch: true });
		const settings = { ...automation, autoQueue: true, rematchTitled: true };
		const titled = { name: "fm_player", title: "FM" };
		await h.queue.schedule(1, "first", settings, titled);
		expect(h.queue.view(1)?.status).toBe("waiting");
		expect(h.saved["1"]?.rematch).toBe("fm_player");
		await h.advance(900);
		expect(h.rematch.runs).toEqual([{ tabId: 1, gameId: "first", at: 1_900 }]);
		expect(h.calls).toHaveLength(0);
		expect(h.queue.view(1)?.status).toBe("rematch");
		expect(h.queue.view(1)?.dueAt).toBe(1_900 + REMATCH.acceptTimeoutMs);
		// Marked at the press, persisted, and the pending plan is gone from the record.
		expect(h.saved["1"]?.session?.rematched).toEqual(["fm_player"]);
		expect(h.saved["1"]?.rematch).toBeUndefined();
		await h.advance(5_000);
		await h.queue.observedGame(1, "rematch-game", settings);
		expect(h.rematch.waiting).toBe(false);
		expect(h.queue.isPending(1)).toBe(false);
		await h.advance(60_000);
		expect(h.calls).toHaveLength(0);
		// The same opponent again: no second run, the ordinary click at the ordinary delay.
		await h.queue.schedule(1, "rematch-game", settings, titled);
		expect(h.saved["1"]?.rematch).toBeUndefined();
		await h.advance(900);
		expect(h.rematch.runs).toHaveLength(1);
		expect(h.calls).toHaveLength(1);
		h.queue.dispose();
	});

	it("an untitled opponent, the setting off, or no rematch step: the ordinary click only", async () => {
		for (const [h, opponent, settings] of [
			[harness({ rematch: true }), { name: "amateur" }, { ...automation, rematchTitled: true }],
			[
				harness({ rematch: true }),
				{ name: "gm", title: "GM" },
				{ ...automation, rematchTitled: false },
			],
			[harness(), { name: "gm", title: "GM" }, { ...automation, rematchTitled: true }],
		] as const) {
			await h.queue.schedule(1, "first", settings, opponent);
			await h.advance(900);
			expect(h.rematch.runs).toHaveLength(0);
			expect(h.calls).toHaveLength(1);
			expect(h.saved["1"]?.rematch).toBeUndefined();
			h.queue.dispose();
		}
	});

	it("the setting turned off during the delay skips the step at attempt time", async () => {
		let allowed = true;
		const h = harness({ rematch: true, rematchAllowed: () => allowed });
		await h.queue.schedule(1, "first", REMATCHING, { name: "gm", title: "GM" });
		allowed = false;
		await h.advance(900);
		expect(h.rematch.runs).toHaveLength(0);
		expect(h.calls).toHaveLength(1);
		expect(h.saved["1"]?.session?.rematched).toBeUndefined();
		h.queue.dispose();
	});

	it("an offer nobody took falls through to the ordinary click at once", async () => {
		const h = harness({ rematch: true });
		h.rematch.outcome = "expired";
		await h.queue.schedule(1, "first", REMATCHING, { name: "gm", title: "GM" });
		await h.advance(900);
		expect(h.rematch.runs).toHaveLength(1);
		expect(h.calls).toEqual([{ tabId: 1, at: 1_900 }]);
		expect(h.queue.view(1)?.status).toBe("retrying");
		h.queue.dispose();
	});

	it("a game already on the board ends the queue like the ordinary click's `in-game`", async () => {
		const h = harness({ rematch: true });
		h.rematch.outcome = "in-game";
		await h.queue.schedule(1, "first", REMATCHING, { name: "gm", title: "GM" });
		await h.advance(900);
		expect(h.calls).toHaveLength(0);
		expect(h.queue.isPending(1)).toBe(false);
		h.queue.dispose();
	});

	it("their offer during the delay runs the step early", async () => {
		const h = harness({ rematch: true, rng: 0.999 });
		await h.queue.schedule(1, "first", REMATCHING, { name: "gm", title: "GM" });
		const dueAt = h.queue.view(1)?.dueAt ?? 0;
		expect(dueAt - 1_000).toBeGreaterThan(REMATCH.incomingPollMs);
		h.rematch.incoming = true;
		await h.advance(REMATCH.incomingPollMs);
		expect(h.rematch.incomingReads).toBe(1);
		expect(h.rematch.runs).toHaveLength(1);
		expect(h.rematch.runs[0]?.at).toBeLessThan(dueAt);
		h.queue.dispose();
	});

	it("the once-only mark and a pending step survive a reload; a marked opponent is not re-offered", async () => {
		const settings = REMATCHING;
		const first = harness({ rematch: true });
		await first.queue.schedule(1, "first", settings, { name: "gm", title: "GM" });
		const pending = structuredClone(first.saved);
		expect(pending["1"]?.rematch).toBe("gm");
		first.queue.dispose();
		// Reloaded mid-delay: the step still runs at the persisted deadline.
		const second = harness({ rematch: true, persisted: pending });
		await second.queue.schedule(1, "first", settings, { name: "gm", title: "GM" });
		await second.advance(900);
		expect(second.rematch.runs).toHaveLength(1);
		const marked = structuredClone(second.saved);
		expect(marked["1"]?.session?.rematched).toEqual(["gm"]);
		second.queue.dispose();
		// Reloaded after the press: the mark holds, and the same opponent gets the ordinary click.
		const third = harness({ rematch: true, persisted: marked });
		await third.queue.observedGame(1, "rematch-game", settings);
		await third.queue.schedule(1, "rematch-game", settings, { name: "gm", title: "GM" });
		expect(third.saved["1"]?.rematch).toBeUndefined();
		await third.advance(900);
		expect(third.rematch.runs).toHaveLength(0);
		expect(third.calls).toHaveLength(1);
		third.queue.dispose();
	});

	it("a due break waits for the rematch game: the session keeps going and samples a fresh break after it", async () => {
		const h = harness({ rematch: true });
		const settings = {
			...automation,
			autoQueue: true,
			rematchTitled: true,
			autoQueueSessionMinMinutes: 1,
			autoQueueSessionMaxMinutes: 1,
			autoQueueBreakMinMinutes: 2,
			autoQueueBreakMaxMinutes: 2,
		};
		await h.queue.observedGame(1, "first", settings);
		await h.advance(60_000);
		await h.queue.schedule(1, "first", settings, { name: "gm", title: "GM" });
		// The break is sampled but not taken: the short delay, then the step.
		expect(h.saved["1"]?.session?.breakUntil).toBe(61_000 + 120_000);
		expect(h.queue.view(1)?.status).toBe("waiting");
		expect(h.queue.view(1)?.dueAt).toBe(61_900);
		await h.advance(900);
		expect(h.rematch.runs).toHaveLength(1);
		await h.queue.observedGame(1, "rematch-game", settings);
		// Same playing session (the game count carries on), the break deferred.
		expect(h.saved["1"]?.session?.completedGames).toBe(1);
		expect(h.saved["1"]?.session?.breakUntil).toBeNull();
		expect(h.breaks).toEqual([]);
		await h.advance(30_000);
		await h.queue.schedule(1, "rematch-game", settings, { name: "gm", title: "GM" });
		expect(h.queue.view(1)?.status).toBe("break");
		expect(h.queue.view(1)?.dueAt).toBe(91_900 + 120_000);
		expect(h.saved["1"]?.session?.completedGames).toBe(2);
		h.queue.dispose();
	});

	it("a due break starts after an offer nobody took, and the owner is told", async () => {
		const h = harness({ rematch: true });
		h.rematch.outcome = "expired";
		const settings = {
			...automation,
			autoQueue: true,
			rematchTitled: true,
			autoQueueSessionMinMinutes: 1,
			autoQueueSessionMaxMinutes: 1,
			autoQueueBreakMinMinutes: 2,
			autoQueueBreakMaxMinutes: 2,
		};
		await h.queue.observedGame(1, "first", settings);
		await h.advance(60_000);
		await h.queue.schedule(1, "first", settings, { name: "gm", title: "GM" });
		await h.advance(900);
		expect(h.rematch.runs).toHaveLength(1);
		expect(h.calls).toHaveLength(0);
		expect(h.queue.view(1)?.status).toBe("break");
		expect(h.queue.view(1)?.dueAt).toBe(181_000);
		expect(h.breaks).toEqual([1]);
		await h.advance(181_000 - 61_900 - 1);
		expect(h.calls).toHaveLength(0);
		await h.advance(1);
		expect(h.calls).toHaveLength(1);
		h.queue.dispose();
	});

	it("cancellation during the wait aborts the step and clears the entry", async () => {
		const h = harness({ rematch: true });
		await h.queue.schedule(1, "first", REMATCHING, { name: "gm", title: "GM" });
		await h.advance(900);
		expect(h.rematch.waiting).toBe(true);
		h.queue.cancel(1);
		await flush();
		expect(h.rematch.waiting).toBe(false);
		expect(h.queue.isPending(1)).toBe(false);
		await h.advance(60_000);
		expect(h.calls).toHaveLength(0);
		h.queue.dispose();
	});

	it("cancellation while storage is loading prevents restoration or a queued schedule", async () => {
		let resolve!: (value: PendingAutoQueues) => void;
		const saved: PendingAutoQueues[] = [];
		const queue = new AutoQueue({
			rng: { ...createRng("queue-test"), next: () => 0 },
			canQueue: () => "allow",
			attempt: async () => {
				throw new Error("must not request");
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
