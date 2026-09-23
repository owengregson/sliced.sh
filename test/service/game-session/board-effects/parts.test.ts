import { describe, expect, test } from "bun:test";
import { REVIEW } from "@core/constants/review";
import {
	ClassificationQueue,
	nextClassification,
} from "@service/game-session/board-effects/classification-queue";
import { FrameStore, isFinal } from "@service/game-session/board-effects/frame-store";
import { moveKey, reviewKey } from "@service/game-session/board-effects/keys";
import { reviewWants } from "@service/game-session/board-effects/review-wants";
import { newVerdictJob, type VerdictJob } from "@service/game-session/board-effects/verdict-job";
import type { EvalLine } from "@typedefs/engine";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Review frames keep only lines searched to the frame's own depth. */
function line(uci: string, depth: number): EvalLine {
	return { multipv: 1, depth, score: { cp: 20 }, pvUci: [uci], pvSan: [uci] };
}

function job(uci: string, ply = 0, landed = false): VerdictJob {
	const move = { beforeFen: START, historyFen: START, historyMoves: [], uci, ply };
	const out = newVerdictJob(moveKey(move), move, true);
	if (landed) out.landed = { at: 0 };
	return out;
}

describe("FrameStore", () => {
	test("keeps the deeper frame and marks a completed shallower search done", () => {
		const store = new FrameStore();
		const none = () => new Set<string>();
		store.store("a", { lines: [line("e2e4", 14)], depth: 14 }, false, none);
		store.store("a", { lines: [line("d2d4", 10)], depth: 10 }, true, none);
		expect(store.get("a")?.depth).toBe(14);
		expect(store.get("a")?.done).toBe(true);
		expect(isFinal(store.get("a"))).toBe(true);
	});

	test("ignores an empty frame unless the search ended", () => {
		const store = new FrameStore();
		store.store("a", { lines: [], depth: 5 }, false, () => new Set());
		expect(store.get("a")).toBeUndefined();
		store.store("a", { lines: [], depth: 5 }, true, () => new Set());
		expect(store.get("a")?.done).toBe(true);
	});

	test("evicts the oldest unpinned frames past the limit and reads the pins only then", () => {
		const store = new FrameStore();
		let reads = 0;
		const pinned = () => {
			reads += 1;
			return new Set(["k0"]);
		};
		for (let i = 0; i <= REVIEW.knownPositions; i += 1)
			store.store(`k${i}`, { lines: [line("e2e4", 12)], depth: 12 }, false, pinned);
		expect(reads).toBe(1);
		expect(store.get("k0")).toBeDefined();
		expect(store.get("k1")).toBeUndefined();
		expect(store.frameFor(START)).toBeNull();
	});
});

describe("nextClassification", () => {
	test("resolves a landed predecessor on the same square first", () => {
		const first = job("e2e4", 0, true);
		const second = job("d2d4", 1, true);
		second.move = { ...second.move, uci: "d1e4" };
		const pending = new Set([first, second]);
		expect(nextClassification([second, first], [first, second], pending)).toBe(first);
		expect(nextClassification([second], [first, second], new Set([second]))).toBe(second);
		expect(nextClassification([first], [first], new Set())).toBeUndefined();
	});
});

describe("ClassificationQueue", () => {
	test("classifies one job per timer turn and stops when admission closes", () => {
		const timers: Array<() => void> = [];
		let admitted = true;
		const classified: VerdictJob[] = [];
		const a = job("e2e4");
		const b = job("d2d4");
		const queue = new ClassificationQueue({
			scheduler: {
				setTimeout: (fn) => timers.push(fn),
				clearTimeout: () => undefined,
			},
			admits: () => admitted,
			pick: (pending) => [...pending][0],
			classify: (j) => classified.push(j),
		});
		queue.add(a);
		queue.add(b);
		expect(timers).toHaveLength(1);
		timers.shift()?.();
		expect(classified).toEqual([a]);
		admitted = false;
		timers.shift()?.();
		expect(classified).toEqual([a]);
		expect(timers).toHaveLength(0);
	});
});

describe("reviewWants", () => {
	test("orders landed halves, the current position and the plan by urgency", () => {
		const landed = job("e2e4", 0, true);
		const prepared = job("d2d4");
		const wants = reviewWants({
			landed: [landed],
			current: { fen: START, history: { fen: START, moves: [] } },
			prepared,
			archive: [],
			frames: new FrameStore(),
			tracked: () => true,
		});
		expect(wants.map((w) => w.urgency)).toEqual([0, 0, 2]);
		expect(wants[0]?.key).toBe(reviewKey(START));
		expect(wants.some((w) => w.urgency === 1)).toBe(false);
	});
});
