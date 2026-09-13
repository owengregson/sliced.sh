import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SEARCH_BUDGET } from "@core/constants/search";
import type {
	AnalysisHandle,
	AnalysisRequest,
	AnalysisResult,
	AnalysisUpdate,
} from "@core/engine/types";
import { searchResultBeforeDeadline } from "@service/game-session/search-deadline";
import { createTimeController, type TimeController } from "@test/sim/time/time-controller";

const START = 10_000;
let time: TimeController;

beforeEach(() => {
	time = createTimeController(START);
	time.install();
});
afterEach(() => time.uninstall());

function pending<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function harness(elo?: number) {
	const request: AnalysisRequest = {
		id: "deadline-search",
		fen: "startpos",
		multiPv: 2,
		limit: { movetimeMs: 600 },
		...(elo === undefined ? {} : { elo }),
	};
	const result = pending<AnalysisResult>();
	let next = pending<IteratorResult<AnalysisUpdate>>();
	let stopCalls = 0;
	let closeCalls = 0;
	let onStop = (): Promise<void> => new Promise(() => {});
	const handle: AnalysisHandle = {
		id: request.id,
		result: result.promise,
		stop: () => {
			stopCalls++;
			return onStop();
		},
		updates: {
			[Symbol.asyncIterator]: () => ({
				next: () => next.promise,
				return: async () => {
					closeCalls++;
					return { done: true, value: undefined };
				},
			}),
		},
	};
	const frame = (depth = 10): AnalysisUpdate => ({
		id: request.id,
		depth,
		complete: true,
		lines: ["e2e4", "d2d4"].map((uci, index) => ({
			multipv: index + 1,
			depth,
			score: { cp: 30 - index * 10 },
			pvUci: [uci],
			pvSan: [],
		})),
		nodes: 123,
		nps: 1000,
		timeMs: 500,
	});
	return {
		handle,
		request,
		result,
		frame,
		stopCalls: () => stopCalls,
		closeCalls: () => closeCalls,
		onStop: (fn: () => Promise<void>) => {
			onStop = fn;
		},
		emit: async (value: AnalysisUpdate) => {
			const waiting = next;
			next = pending<IteratorResult<AnalysisUpdate>>();
			waiting.resolve({ done: false, value });
			await time.runMicrotasks();
		},
		answer: (bestmove = "d2d4"): AnalysisResult => ({
			id: request.id,
			request,
			bestmove,
			status: "complete",
			final: frame(),
		}),
	};
}

const options = () => ({ deadlineMs: START + 600, now: time.now });

describe("search wall-clock deadline", () => {
	it("returns an ordinary result unchanged and removes its timer and stream reader", async () => {
		const h = harness();
		const result = searchResultBeforeDeadline(h.handle, h.request, options());
		const answer = h.answer();
		h.result.resolve(answer);
		expect(await result).toBe(answer);
		await time.runMicrotasks();
		expect(h.stopCalls()).toBe(0);
		expect(h.closeCalls()).toBe(1);
		expect(time.pendingTimers()).toBe(0);
	});

	it("stops a request still queued at the deadline and bounds a missing stop receipt", async () => {
		const h = harness();
		const result = searchResultBeforeDeadline(h.handle, h.request, options());
		await time.advance(599);
		expect(h.stopCalls()).toBe(0);
		await time.advance(1);
		expect(h.stopCalls()).toBe(1);
		await time.advance(SEARCH_BUDGET.stopReceiptMs);
		expect(await result).toBeNull();
		expect(time.now()).toBe(START + 600 + SEARCH_BUDGET.stopReceiptMs);
		expect(time.pendingTimers()).toBe(0);
		expect(h.closeCalls()).toBe(1);
	});

	it("accepts the actual native bestmove arriving during the stop receipt allowance", async () => {
		const h = harness(1700);
		const answer = h.answer("d2d4");
		h.onStop(() => {
			setTimeout(() => h.result.resolve(answer), 20);
			return h.result.promise.then(() => {});
		});
		const result = searchResultBeforeDeadline(h.handle, h.request, options());
		await time.advance(620);
		expect(await result).toBe(answer);
		expect((await result)?.bestmove).toBe("d2d4");
		expect(h.stopCalls()).toBe(1);
		expect(time.pendingTimers()).toBe(0);
	});

	it.each(["partial", "mixed-depth", "duplicate-root", "bound", "unscored"])(
		"retains the last coherent frame instead of a later %s update when stop stalls",
		async (invalid) => {
			const h = harness();
			const result = searchResultBeforeDeadline(h.handle, h.request, options());
			const complete = h.frame(10);
			await h.emit(complete);
			const later = h.frame(11);
			if (invalid === "partial") later.complete = false;
			if (invalid === "mixed-depth") later.lines[1]!.depth = 10;
			if (invalid === "duplicate-root") later.lines[1]!.pvUci = ["e2e4"];
			if (invalid === "bound") later.lines[1]!.bound = "lower";
			if (invalid === "unscored") later.lines[1]!.score = {};
			await h.emit(later);
			await time.advance(600 + SEARCH_BUDGET.stopReceiptMs);
			expect(await result).toMatchObject({
				bestmove: null,
				status: "superseded",
				final: { ...complete, complete: false },
			});
			expect(time.pendingTimers()).toBe(0);
		}
	);

	it("does not substitute the top PV for a missing rating-limited bestmove", async () => {
		const h = harness(1700);
		const result = searchResultBeforeDeadline(h.handle, h.request, options());
		await h.emit(h.frame());
		await time.advance(600 + SEARCH_BUDGET.stopReceiptMs);
		expect(await result).toBeNull();
	});

	it.each([false, true])(
		"abort resolves immediately, including already aborted input: %s",
		async (already) => {
			const h = harness();
			const abort = new AbortController();
			if (already) abort.abort();
			const result = searchResultBeforeDeadline(h.handle, h.request, {
				...options(),
				signal: abort.signal,
			});
			abort.abort();
			expect(await result).toBeNull();
			expect(h.stopCalls()).toBe(1);
			expect(time.now()).toBe(START);
			expect(time.pendingTimers()).toBe(0);
			// A transport rejecting later must still have a rejection handler.
			h.result.reject(new Error("transport closed"));
			await time.runMicrotasks();
		}
	);

	it.each(["throw", "reject"])(
		"a stop that fails via %s still cannot exceed the grace",
		async (failure) => {
			const h = harness();
			h.onStop(() => {
				if (failure === "throw") throw new Error("stop failed");
				return Promise.reject(new Error("stop failed"));
			});
			const result = searchResultBeforeDeadline(h.handle, h.request, options());
			await time.advance(600 + SEARCH_BUDGET.stopReceiptMs);
			expect(await result).toBeNull();
			expect(time.pendingTimers()).toBe(0);
		}
	);

	it("an elapsed deadline stops immediately and abort during stop leaves no timer", async () => {
		const h = harness();
		const abort = new AbortController();
		h.onStop(() => {
			abort.abort();
			return Promise.resolve();
		});
		const result = searchResultBeforeDeadline(h.handle, h.request, {
			deadlineMs: START - 1,
			now: time.now,
			signal: abort.signal,
		});
		expect(await result).toBeNull();
		expect(h.stopCalls()).toBe(1);
		expect(time.pendingTimers()).toBe(0);
	});

	it("an absent deadline keeps the normal result path and clears its abort listener", async () => {
		const h = harness();
		const abort = new AbortController();
		const result = searchResultBeforeDeadline(h.handle, h.request, { signal: abort.signal });
		await time.advance(5000);
		expect(h.stopCalls()).toBe(0);
		h.result.resolve(h.answer());
		expect((await result)?.status).toBe("complete");
		abort.abort();
		expect(h.stopCalls()).toBe(0);
		expect(time.pendingTimers()).toBe(0);
	});
});
