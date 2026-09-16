// test/service/review-engine.test.ts — the shared full-network review engine (2026-09-14): request
// bounds, priority preemption, the boot-failure back-off and releasing the engine.
import { describe, expect, it } from "bun:test";
import { ENGINE_FILES } from "@core/constants/engine-files";
import { REVIEW } from "@core/constants/review";
import type {
	AnalysisHandle,
	AnalysisRequest,
	AnalysisResult,
	AnalysisUpdate,
} from "@core/engine/types";
import {
	fullReviewReady,
	type ReviewBackend,
	ReviewEngine,
	reviewThreads,
} from "@service/review-engine";
import type { EngineStatus } from "@typedefs/engine";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const READY: EngineStatus = {
	state: "ready",
	variant: "full",
	threads: 2,
	nnue: [...ENGINE_FILES.full.nnue],
	version: "Stockfish 19",
};

function request(
	id: string,
	priority: NonNullable<AnalysisRequest["priority"]>,
	over: Partial<AnalysisRequest> = {}
): AnalysisRequest {
	return { id, fen: START, multiPv: 3, limit: { depth: 18, movetimeMs: 5000 }, priority, ...over };
}

function fakeBackends(
	options: {
		failWarm?: () => boolean;
		status?: () => EngineStatus;
		warm?: () => Promise<void>;
		deferStop?: boolean;
	} = {}
) {
	type FakeSearch = {
		req: AnalysisRequest;
		stopped: boolean;
		update(): void;
		finish(status?: AnalysisResult["status"]): void;
	};
	const created: Array<{ searches: FakeSearch[]; disposed: boolean }> = [];
	const createBackend = (): ReviewBackend => {
		const record = { searches: [] as FakeSearch[], disposed: false };
		created.push(record);
		return {
			warm: async () => {
				await options.warm?.();
				if (options.failWarm?.()) throw new Error("boot failed");
			},
			status: () => options.status?.() ?? READY,
			dispose: () => {
				record.disposed = true;
			},
			analyse(req): AnalysisHandle {
				const queue: AnalysisUpdate[] = [];
				let done = false;
				let wake: (() => void) | undefined;
				let resolve: (result: AnalysisResult) => void = () => {};
				const result = new Promise<AnalysisResult>((r) => {
					resolve = r;
				});
				const final: AnalysisUpdate = {
					id: req.id,
					depth: 18,
					lines: [],
					nodes: 1,
					nps: 1,
					timeMs: 1,
					complete: true,
				};
				const search: FakeSearch = {
					req,
					stopped: false,
					update: () => {
						queue.push(final);
						wake?.();
					},
					finish: (status = "complete") => {
						done = true;
						wake?.();
						resolve({
							id: req.id,
							request: req,
							status,
							bestmove: "e2e4",
							final,
						} as AnalysisResult);
					},
				};
				record.searches.push(search);
				return {
					id: req.id,
					updates: (async function* () {
						while (true) {
							while (queue.length > 0) yield queue.shift() as AnalysisUpdate;
							if (done) return;
							await new Promise<void>((resolve) => {
								wake = resolve;
							});
						}
					})(),
					result,
					stop: async () => {
						search.stopped = true;
						if (!options.deferStop) search.finish();
					},
				};
			},
		};
	};
	return { created, createBackend };
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("ReviewEngine", () => {
	it("holds queued jobs until every owner releases, retaining warm state and priority", async () => {
		const { created, createBackend } = fakeBackends();
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		await engine.warm();
		engine.setPlayBusy("tab:1", true);
		engine.setPlayBusy("tab:1", true);
		engine.setPlayBusy("tab:2", true);
		const panel = engine.analyse(request("panel", "panel"));
		const move = engine.analyse(request("move", "move"));
		await settle();
		expect(created[0]?.searches).toHaveLength(0);
		engine.setPlayBusy("unknown", false);
		engine.setPlayBusy("tab:1", false);
		await settle();
		expect(created[0]?.searches).toHaveLength(0);
		engine.setPlayBusy("tab:2", false);
		await settle();
		expect(created).toHaveLength(1);
		expect(created[0]?.disposed).toBe(false);
		expect(created[0]?.searches[0]?.req.id).toBe("move");
		created[0]?.searches[0]?.finish();
		await move.result;
		await settle();
		expect(created[0]?.searches[1]?.req.id).toBe("panel");
		created[0]?.searches[1]?.finish();
		expect((await panel.result).status).toBe("complete");
		engine.dispose();
	});

	it("retains valid complete iterations and waits for cooperative stop before resuming", async () => {
		const { created, createBackend } = fakeBackends({ deferStop: true });
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		const active = engine.analyse(request("active", "move"));
		const updates: AnalysisUpdate[] = [];
		const reading = (async () => {
			for await (const update of active.updates) updates.push(update);
		})();
		await settle();
		const old = created[0]?.searches[0];
		old?.update();
		await settle();
		expect(updates).toHaveLength(1);
		const queued = engine.analyse(request("queued", "panel"));
		engine.setPlayBusy("tab:1", true);
		expect(old?.stopped).toBe(true);
		let settled = false;
		void active.result.then(() => {
			settled = true;
		});
		await settle();
		expect(settled).toBe(false);
		engine.setPlayBusy("tab:1", false);
		await settle();
		expect(created[0]?.searches).toHaveLength(1);
		old?.update();
		old?.finish();
		await reading;
		await settle();
		expect(updates).toHaveLength(2);
		expect((await active.result).final.depth).toBe(18);
		expect((await active.result).status).toBe("superseded");
		expect(created[0]?.searches[1]?.req.id).toBe("queued");
		created[0]?.searches[1]?.finish();
		expect((await queued.result).status).toBe("complete");
		engine.dispose();
	});

	it("retains undrained iterations from an already completed search across a pause", async () => {
		const { created, createBackend } = fakeBackends();
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		const handle = engine.analyse(request("finished", "move"));
		await settle();
		created[0]?.searches[0]?.update();
		created[0]?.searches[0]?.finish();
		await handle.result;
		await settle();
		engine.setPlayBusy("tab:1", true);
		engine.setPlayBusy("tab:1", false);
		const updates: AnalysisUpdate[] = [];
		for await (const update of handle.updates) updates.push(update);
		expect(updates).toHaveLength(1);
		engine.dispose();
	});

	it("rejects changed engine identity even when a preparation stop has valid-looking frames", async () => {
		let status = READY;
		const { created, createBackend } = fakeBackends({ deferStop: true, status: () => status });
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		const handle = engine.analyse(request("identity-change", "move"));
		await settle();
		engine.setPlayBusy("tab:1", true);
		status = { ...READY, version: "different full engine" };
		created[0]?.searches[0]?.finish();
		expect((await handle.result).status).toBe("failed");
		expect((await handle.result).final.complete).toBe(false);
		expect(created[0]?.disposed).toBe(true);
		engine.dispose();
	});

	it("release still invalidates undrained iterations from completed searches", async () => {
		const { created, createBackend } = fakeBackends();
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		const handle = engine.analyse(request("released", "move"));
		await settle();
		created[0]?.searches[0]?.update();
		created[0]?.searches[0]?.finish();
		await handle.result;
		engine.release();
		const updates: AnalysisUpdate[] = [];
		for await (const update of handle.updates) updates.push(update);
		expect(updates).toHaveLength(0);
		engine.dispose();
	});

	it("does not start a search after a paused warmup completes", async () => {
		let ready: () => void = () => {};
		const warm = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const { created, createBackend } = fakeBackends({ warm: () => warm });
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		const active = engine.analyse(request("warming", "move"));
		await settle();
		engine.setPlayBusy("tab:1", true);
		const queued = engine.analyse(request("queued", "move"));
		ready();
		await settle();
		expect((await active.result).status).toBe("superseded");
		expect(created[0]?.searches).toHaveLength(0);
		engine.setPlayBusy("tab:1", false);
		await settle();
		expect(created).toHaveLength(1);
		expect(created[0]?.searches[0]?.req.id).toBe("queued");
		created[0]?.searches[0]?.finish();
		await queued.result;
		engine.dispose();
	});

	it("cancels queued work while paused and dispose settles the rest without booting", async () => {
		const { created, createBackend } = fakeBackends();
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		engine.setPlayBusy("tab:1", true);
		const cancelled = engine.analyse(request("cancel", "move"));
		const pending = engine.analyse(request("pending", "move"));
		await cancelled.stop();
		expect((await cancelled.result).status).toBe("superseded");
		engine.dispose();
		expect((await pending.result).status).toBe("superseded");
		engine.setPlayBusy("tab:1", false);
		await settle();
		expect(created).toHaveLength(0);
	});

	it("keeps an owner's admission hold across release and skips cancelled queued jobs", async () => {
		const { created, createBackend } = fakeBackends();
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		await engine.warm();
		engine.setPlayBusy("tab:1", true);
		engine.release();
		const cancelled = engine.analyse(request("cancel", "move"));
		await cancelled.stop();
		const pending = engine.analyse(request("pending", "move"));
		await settle();
		expect(created).toHaveLength(1);
		engine.setPlayBusy("tab:1", false);
		await settle();
		expect(created).toHaveLength(2);
		expect(created[1]?.searches.map((s) => s.req.id)).toEqual(["pending"]);
		created[1]?.searches[0]?.finish();
		await pending.result;
		engine.dispose();
	});

	it("discards a result if the loaded network changes during its search", async () => {
		let status = READY;
		const { created, createBackend } = fakeBackends({ status: () => status });
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		const handle = engine.analyse(request("network-change", "move"));
		await settle();
		status = { ...READY, nnue: [ENGINE_FILES.smallnet.nnue] };
		created[0]?.searches[0]?.finish();
		expect((await handle.result).status).toBe("failed");
		expect(created[0]?.disposed).toBe(true);
		engine.dispose();
	});
	it("accepts only a ready full instance carrying the exact full network", () => {
		expect(fullReviewReady(READY)).toBe(true);
		for (const patch of [
			{ nnue: [] },
			{ nnue: [ENGINE_FILES.smallnet.nnue] },
			{ variant: "smallnet" },
			{ fallbackFrom: "full" },
			{ state: "loading-nnue" },
			{ error: "failed NNUE load" },
		] as Partial<EngineStatus>[])
			expect(fullReviewReady({ ...READY, ...patch })).toBe(false);
	});
	it("never asks for more than the review shape", async () => {
		const { created, createBackend } = fakeBackends();
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		engine.analyse(
			request("a", "move", { multiPv: 12, limit: { depth: 40, movetimeMs: 60_000 }, elo: 1200 })
		);
		await settle();
		const sent = created[0]?.searches[0]?.req;
		expect(sent?.multiPv).toBe(REVIEW.multiPv);
		expect(sent?.limit).toEqual({ depth: REVIEW.targetDepth, movetimeMs: REVIEW.movetimeMs });
		expect(sent?.elo).toBeUndefined();
		engine.dispose();
	});

	it("lets a more urgent review interrupt the running one, which still answers", async () => {
		const { created, createBackend } = fakeBackends();
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		const speculative = engine.analyse(request("spec", "panel"));
		await settle();
		const landed = engine.analyse(request("landed", "move"));
		await settle();
		const backend = created[0];
		expect(backend?.searches[0]?.stopped).toBe(true);
		expect((await speculative.result).status).toBe("superseded");
		expect(backend?.searches[1]?.req.id).toBe("landed");
		backend?.searches[1]?.finish();
		expect((await landed.result).status).toBe("complete");
		engine.dispose();
	});

	it("retries a crashed boot within a second, backing off further only while it keeps failing", async () => {
		// The owner's log (2026-09-15): the full build's first two boots crashed in a worker thread
		// ("table index is out of bounds") and each crash cost 30 s of ratings; the third boot worked.
		let now = 0;
		let failing = true;
		const { created, createBackend } = fakeBackends({ failWarm: () => failing });
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend, now: () => now });
		expect((await engine.analyse(request("a", "move")).result).status).toBe("failed");
		// Not again at once …
		expect((await engine.analyse(request("b", "move")).result).status).toBe("failed");
		expect(created).toHaveLength(1);
		// … but within a second.
		now += 1_000;
		expect((await engine.analyse(request("c", "move")).result).status).toBe("failed");
		expect(created).toHaveLength(2);
		// A second failure in a row waits longer than the first.
		now += 1_000;
		expect((await engine.analyse(request("d", "move")).result).status).toBe("failed");
		expect(created).toHaveLength(2);
		now += 30_000;
		failing = false;
		const retried = engine.analyse(request("e", "move"));
		await settle();
		expect(created).toHaveLength(3);
		created[2]?.searches[0]?.finish();
		expect((await retried.result).status).toBe("complete");
		engine.dispose();
	});

	it("drops an engine whose search failed and boots a fresh one after the back-off", async () => {
		// A crash after a good boot: the host's own reboots may run out, and then it never answers.
		let now = 0;
		const { created, createBackend } = fakeBackends();
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend, now: () => now });
		const crashed = engine.analyse(request("a", "move"));
		await settle();
		created[0]?.searches[0]?.finish("failed");
		expect((await crashed.result).status).toBe("failed");
		expect(created[0]?.disposed).toBe(true);
		expect((await engine.analyse(request("b", "move")).result).status).toBe("failed");
		expect(created).toHaveLength(1);
		now += REVIEW.retryBackoffMs[0];
		const retried = engine.analyse(request("c", "move"));
		await settle();
		expect(created).toHaveLength(2);
		created[1]?.searches[0]?.finish();
		expect((await retried.result).status).toBe("complete");
		engine.dispose();
	});

	it("releases the engine and boots it again on the next request", async () => {
		const { created, createBackend } = fakeBackends();
		const engine = new ReviewEngine({ ensureHost: async () => {}, createBackend });
		const pending = engine.analyse(request("a", "ponder"));
		await settle();
		engine.release();
		expect((await pending.result).status).toBe("superseded");
		expect(created[0]?.disposed).toBe(true);
		engine.analyse(request("b", "ponder"));
		await settle();
		expect(created).toHaveLength(2);
		engine.dispose();
	});

	it("takes half the cores within its bounds", () => {
		expect(reviewThreads(undefined)).toBe(REVIEW.threadsMin);
		expect(reviewThreads(2)).toBe(1);
		expect(reviewThreads(5)).toBe(2);
		expect(reviewThreads(10)).toBe(REVIEW.threadsMax);
		expect(reviewThreads(64)).toBe(REVIEW.threadsMax);
	});
});
