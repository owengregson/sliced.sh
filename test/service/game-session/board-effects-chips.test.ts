// test/service/game-session/board-effects-chips.test.ts — `BoardEffectsReporter` over a scripted
// review engine and a manual clock (2026-09-14): what it asks the review engine for and in which
// order, and when a landed move's rating ships — separately after the immediate effects, even
// when the verdict was prepared ahead of time. Later badges never replay an effect list.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { boardEffectsFor } from "@core/chess/board-effects";
import { applyMoves } from "@core/chess/san";
import type { GamePortCommand } from "@core/constants/messages";
import { MOVE_QUALITY, type MoveListRating } from "@core/constants/move-quality";
import { REVIEW } from "@core/constants/review";
import * as moveQuality from "@core/engine/move-quality";
import type {
	AnalysisHandle,
	AnalysisRequest,
	AnalysisResult,
	AnalysisUpdate,
} from "@core/engine/types";
import type { Scheduler } from "@core/util/scheduler";
import {
	BoardEffectsReporter,
	type LandedMove,
	type MateNote,
	matePitch,
	mateSemitones,
} from "@service/game-session/board-effects";
import type { Eval, EvalLine } from "@typedefs/engine";
import type { MoveQualityChipSide } from "@typedefs/settings";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

type Effects = Extract<GamePortCommand, { kind: "effects" }>;

interface Search {
	req: AnalysisRequest;
	stopped: boolean;
	done: boolean;
	update(depth: number, lines: EvalLine[]): void;
	finish(status?: AnalysisResult["status"]): void;
}

function line(
	multipv: number,
	uci: string,
	score: Eval,
	depth: number = REVIEW.targetDepth
): EvalLine {
	return { multipv, score, depth, pvUci: [uci], pvSan: [] };
}

function fakeReviewer() {
	const searches: Search[] = [];
	const reviewer = {
		warms: 0,
		async warm(): Promise<void> {
			reviewer.warms += 1;
		},
		analyse(req: AnalysisRequest): AnalysisHandle {
			const queue: AnalysisUpdate[] = [];
			let wake: (() => void) | null = null;
			let last: AnalysisUpdate = {
				id: req.id,
				depth: 0,
				lines: [],
				nodes: 0,
				nps: 0,
				timeMs: 0,
				complete: false,
			};
			let resolve: (result: AnalysisResult) => void = () => {};
			const result = new Promise<AnalysisResult>((r) => {
				resolve = r;
			});
			const search: Search = {
				req,
				stopped: false,
				done: false,
				update(depth, lines) {
					last = { ...last, depth, lines, complete: true };
					queue.push(last);
					wake?.();
				},
				finish(status = "complete") {
					if (search.done) return;
					search.done = true;
					wake?.();
					resolve({ id: req.id, request: req, status, bestmove: null, final: last } as AnalysisResult);
				},
			};
			async function* updates(): AsyncGenerator<AnalysisUpdate> {
				while (true) {
					while (queue.length > 0) yield queue.shift() as AnalysisUpdate;
					if (search.done) return;
					await new Promise<void>((r) => {
						wake = r;
					});
					wake = null;
				}
			}
			searches.push(search);
			return {
				id: req.id,
				updates: updates(),
				result,
				stop: async () => {
					search.stopped = true;
					search.finish("superseded");
				},
			};
		},
	};
	return { reviewer, searches };
}

// Settle advances zero-delay timer turns as well as engine microtasks; time does not elapse.
const timerTurns = new Set<() => void>();
afterEach(() => timerTurns.clear());

function manualClock() {
	let now = 1_000;
	const timers: Array<{ at: number; fn: () => void }> = [];
	const scheduler: Scheduler = {
		setTimeout(fn, ms) {
			const timer = { at: now + ms, fn };
			timers.push(timer);
			return timer;
		},
		clearTimeout(handle) {
			const at = timers.indexOf(handle as (typeof timers)[number]);
			if (at >= 0) timers.splice(at, 1);
		},
	};
	const clock = {
		now: () => now,
		scheduler,
		advance(ms: number) {
			now += ms;
			for (const timer of timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)) {
				timers.splice(timers.indexOf(timer), 1);
				timer.fn();
			}
		},
	};
	timerTurns.add(() => clock.advance(0));
	return clock;
}

const microtasks = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};
const settle = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
		for (const turn of timerTurns) turn();
	}
};

function setup(
	over: {
		chips?: boolean;
		rays?: boolean;
		chipsFor?: () => MoveQualityChipSide;
		bookMoves?: (fen: string) => Promise<string[]>;
		fail?: boolean;
		annotate?: (rating: MoveListRating) => void;
	} = {}
) {
	const posts: GamePortCommand[] = [];
	const { reviewer, searches } = fakeReviewer();
	const clock = manualClock();
	const r = new BoardEffectsReporter({
		reviewer: () => reviewer,
		post: (cmd) => posts.push(cmd),
		...(over.annotate ? { annotate: over.annotate } : {}),
		...(over.chips === undefined ? {} : { chips: () => over.chips as boolean }),
		...(over.rays === undefined ? {} : { rays: () => over.rays as boolean }),
		...(over.chipsFor ? { chipsFor: over.chipsFor } : {}),
		...(over.bookMoves ? { bookMoves: over.bookMoves } : {}),
		scheduler: clock.scheduler,
		now: clock.now,
	});
	const effects = (): Effects[] => posts.filter((p): p is Effects => p.kind === "effects");
	const open = (moves: readonly string[]): Search | undefined =>
		[...searches]
			.reverse()
			.find((s: Search) => !s.done && (s.req.moves ?? []).join(" ") === moves.join(" "));
	return { r, posts, effects, searches, open, clock, reviewer };
}

const landed = (uci: string, mine: boolean, historyMoves: string[] = []): LandedMove => ({
	beforeFen: applyMoves(START, historyMoves) ?? START,
	historyFen: START,
	historyMoves,
	uci,
	ply: historyMoves.length,
	mine,
});

/** The start position reviewed to its target depth: e4, d4, Nf3. */
const startLines = (): EvalLine[] => [
	line(1, "e2e4", { cp: 30 }),
	line(2, "d2d4", { cp: 25 }),
	line(3, "g1f3", { cp: 20 }),
];

describe("BoardEffectsReporter · play admission", () => {
	it("posts arrows before starting any rating work, even when book and review answers stall", async () => {
		let atLookup: Effects[] = [];
		let lookupCount = 0;
		const h = setup({
			bookMoves: () => {
				lookupCount += 1;
				atLookup = [...h.effects()];
				return new Promise<string[]>(() => {});
			},
		});
		try {
			const move = landed("e4d5", true, ["e2e4", "d7d5"]);
			h.r.report({ moves: [move] });
			expect(lookupCount).toBe(1);
			expect(atLookup).toEqual([
				{
					kind: "effects",
					mine: true,
					effects: boardEffectsFor({ fen: move.beforeFen, uci: move.uci }),
				},
			]);
			expect(atLookup[0]?.effects).toContainEqual({ kind: "capture", from: "e4", to: "d5" });
			await settle();
			expect(h.effects()).toEqual(atLookup);
		} finally {
			h.r.dispose();
		}
	});

	it("preserves frames and rays but defers classification, timers and chips until resume", async () => {
		const { r, effects, open, searches, clock, reviewer } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		open([])?.finish();
		await settle();
		const speculative = open(["e2e4"]);
		const classify = spyOn(moveQuality, "classifyMoveQuality");
		try {
			r.setPlayBusy(true);
			r.setPlayBusy(true);
			expect(speculative?.stopped).toBe(true);
			const count = searches.length;
			r.warm();
			r.report({ moves: [landed("e2e4", true)] });
			clock.advance(REVIEW.landedWaitMs * 10);
			await settle();
			expect(reviewer.warms).toBe(0);
			expect(searches).toHaveLength(count);
			expect(classify).not.toHaveBeenCalled();
			expect(r.frameFor(START)?.depth).toBe(REVIEW.targetDepth);
			expect(effects()).toHaveLength(1);
			expect(effects()[0]?.effects).toEqual(boardEffectsFor({ fen: START, uci: "e2e4" }));
			expect(effects()[0]?.quality).toBeUndefined();
			expect(r.stats()).toEqual({ delivered: 0, dropped: {} });
			r.setPlayBusy(false);
			r.setPlayBusy(false);
			expect(classify).not.toHaveBeenCalled();
			clock.advance(0);
			expect(classify).toHaveBeenCalledTimes(1);
			expect(effects()).toHaveLength(2);
			expect(effects()[1]?.quality?.quality).toBe("best");
			expect(r.stats()).toEqual({ delivered: 1, dropped: {} });
		} finally {
			classify.mockRestore();
			r.dispose();
		}
	});

	it("publishes an already prepared verdict during the pause without classifying again", async () => {
		const { r, effects, open } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		open([])?.finish();
		await settle();
		r.prepare({ beforeFen: START, history: { fen: START, moves: [] }, uci: "e2e4", ply: 0 });
		await settle();
		const classify = spyOn(moveQuality, "classifyMoveQuality");
		try {
			r.setPlayBusy(true);
			r.report({ moves: [landed("e2e4", true)] });
			expect(effects()).toHaveLength(2);
			expect(effects()[0]?.quality).toBeUndefined();
			expect(effects()[1]?.quality?.quality).toBe("best");
			expect(classify).not.toHaveBeenCalled();
			r.setPlayBusy(false);
			expect(effects()).toHaveLength(2);
		} finally {
			classify.mockRestore();
			r.dispose();
		}
	});

	it("retains complete stopped-search evidence without restarting the completed key", async () => {
		const { r, effects, open, searches } = setup();
		r.report({ moves: [landed("e2e4", true)] });
		const old = open([]);
		old?.update(9, [line(1, "e2e4", { cp: 30 }, 9)]);
		await settle();
		old?.update(REVIEW.targetDepth, startLines());
		r.setPlayBusy(true);
		await settle();
		expect(old?.stopped).toBe(true);
		expect(r.frameFor(START)?.depth).toBe(18);
		expect(effects()).toHaveLength(1);
		r.setPlayBusy(false);
		await settle();
		expect(searches.filter((s) => !s.req.moves?.length)).toHaveLength(1);
		expect(effects()[1]?.quality?.quality).toBe("best");
		r.dispose();
	});

	it("bounds paused work to two plies, prioritizes fresh work and reuses a useful active key", async () => {
		const { r, effects, open, searches } = setup();
		const moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"];
		r.setPlayBusy(true);
		r.report({
			moves: moves.slice(0, 4).map((uci, i) => landed(uci, i % 2 === 0, moves.slice(0, i))),
		});
		expect(effects()).toHaveLength(4);
		expect(searches).toHaveLength(0);
		expect(r.stats()).toEqual({ delivered: 0, dropped: { "no-frame": 2 } });
		r.setPlayBusy(false);
		const useful = open(moves.slice(0, 3));
		expect(useful).toBeDefined();
		r.report({ moves: [landed(moves[4]!, true, moves.slice(0, 4))] });
		expect(useful?.stopped).toBe(false);
		expect(r.stats().dropped).toEqual({ "no-frame": 3 });
		useful?.update(18, [line(1, "b8c6", { cp: 30 })]);
		useful?.finish();
		await settle();
		const fresh = open(moves.slice(0, 4));
		expect(fresh).toBeDefined();
		fresh?.update(18, [line(1, "f1c4", { cp: 30 })]);
		fresh?.finish();
		await settle();
		expect(
			effects()
				.filter((e) => e.quality)
				.map((e) => e.quality?.square)
		).toEqual(["c6", "c4"]);
		expect(r.stats()).toEqual({ delivered: 2, dropped: { "no-frame": 3 } });
		r.dispose();
	});

	it("continues searching and caching through mouse input, then classifies one job per turn", async () => {
		const { r, effects, open, clock } = setup();
		r.setInputBusy(true);
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		const before = open([]);
		expect(before).toBeDefined();
		before?.update(18, startLines());
		before?.finish();
		await settle();
		const after = open(["e2e4"]);
		expect(after).toBeDefined();
		after?.update(18, [line(1, "e7e5", { cp: 20 })]);
		after?.finish();
		await settle();
		expect(r.frameFor(applyMoves(START, ["e2e4"])!)?.depth).toBe(18);
		const classify = spyOn(moveQuality, "classifyMoveQuality");
		try {
			r.report({ moves: [landed("e2e4", true), landed("e7e5", false, ["e2e4"])] });
			await settle();
			expect(classify).not.toHaveBeenCalled();
			expect(effects()).toHaveLength(2);
			r.setInputBusy(false);
			expect(classify).not.toHaveBeenCalled();
			clock.advance(0);
			expect(classify).toHaveBeenCalledTimes(1);
			expect(effects().at(-1)?.quality?.square).toBe("e5");
			// A new input event between timer turns stops the remaining synchronous work.
			r.setInputBusy(true);
			clock.advance(0);
			expect(classify).toHaveBeenCalledTimes(1);
			r.setInputBusy(false);
			clock.advance(0);
			expect(classify).toHaveBeenCalledTimes(2);
			expect(effects().at(-1)?.quality?.square).toBe("e4");
			expect(r.stats().delivered).toBe(2);
		} finally {
			classify.mockRestore();
			r.dispose();
		}
	});

	it("classifies a same-square capture pair in landing order while yielding between them", async () => {
		const { r, effects, open, clock } = setup();
		const fen = "4k3/8/4p3/3p4/4P3/8/8/4K3 w - - 0 1";
		const after = applyMoves(fen, ["e4d5"])!;
		r.setInputBusy(true);
		r.observe({ fen, history: { fen, moves: [] } });
		open([])?.update(18, [line(1, "e4d5", { cp: 20 })]);
		open([])?.finish();
		await settle();
		r.observe({ fen: after, history: { fen, moves: ["e4d5"] } });
		open(["e4d5"])?.update(18, [line(1, "e6d5", { cp: 20 })]);
		open(["e4d5"])?.finish();
		await settle();
		r.report({
			moves: [
				{ beforeFen: fen, historyFen: fen, historyMoves: [], uci: "e4d5", ply: 0, mine: false },
				{ beforeFen: after, historyFen: fen, historyMoves: ["e4d5"], uci: "e6d5", ply: 1, mine: true },
			],
		});
		r.setInputBusy(false);
		clock.advance(0);
		expect(
			effects()
				.filter((e) => e.quality)
				.map((e) => e.mine)
		).toEqual([false]);
		clock.advance(0);
		expect(
			effects()
				.filter((e) => e.quality)
				.map((e) => e.mine)
		).toEqual([false, true]);
		expect(r.stats()).toEqual({ delivered: 2, dropped: {} });
		r.dispose();
	});

	it("admits before the supplied lead boundary, rechecks it on the timer turn and resumes when cleared", async () => {
		const { r, effects, open, clock, searches } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(18, startLines());
		open([])?.finish();
		await settle();
		const classify = spyOn(moveQuality, "classifyMoveQuality");
		try {
			r.setAvailableUntil(clock.now() + 1);
			r.prepare({ beforeFen: START, history: { fen: START, moves: [] }, uci: "e2e4", ply: 0 });
			clock.advance(0);
			expect(classify).toHaveBeenCalledTimes(1); // no second 300 ms reserve
			r.setInputBusy(true);
			r.report({ moves: [landed("e2e4", true)] });
			expect(effects().at(-1)?.quality?.quality).toBe("best"); // cached verdict is cheap
			r.setInputBusy(false);
			r.report({ moves: [landed("d2d4", false)] });
			clock.advance(1); // queued while admissible, timer fires at the boundary
			expect(classify).toHaveBeenCalledTimes(1);
			expect(searches.some((search) => !search.done)).toBe(true);
			r.setAvailableUntil(null);
			clock.advance(0);
			expect(classify).toHaveBeenCalledTimes(2);
			expect(r.stats().delivered).toBe(2);
		} finally {
			classify.mockRestore();
			r.dispose();
		}
	});

	it("retains an interrupted shallow iteration as nonterminal and resumes its search", async () => {
		const { r, open, clock, effects, searches } = setup();
		r.report({ moves: [landed("e2e4", true)] });
		const interrupted = open([]);
		interrupted?.update(11, [line(1, "e2e4", { cp: 30 }, 11)]);
		r.setPlayBusy(true);
		await microtasks();
		expect(r.frameFor(START)?.depth).toBe(11);
		clock.advance(REVIEW.landedWaitMs);
		r.setPlayBusy(false);
		await settle();
		expect(effects().some((e) => e.quality)).toBe(false);
		expect(searches.filter((search) => !search.req.moves?.length)).toHaveLength(2);
		expect(open([])).not.toBe(interrupted);
		r.dispose();
	});

	it.each(["cancel", "dispose"] as const)(
		"%s removes a queued classification timer",
		async (action) => {
			const { r, open, clock, effects } = setup();
			r.observe({ fen: START, history: { fen: START, moves: [] } });
			open([])?.update(18, startLines());
			open([])?.finish();
			await settle();
			r.report({ moves: [landed("e2e4", true)] });
			r[action]();
			clock.advance(0);
			expect(effects()).toHaveLength(1);
			expect(effects()[0]?.quality).toBeUndefined();
			r.dispose();
		}
	);

	it("defers a late book answer and emits only the chip on resume when rays are off", async () => {
		let answer: (moves: string[]) => void = () => {};
		const books = new Promise<string[]>((resolve) => {
			answer = resolve;
		});
		const { r, effects, open, clock } = setup({ rays: false, bookMoves: () => books });
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		open([])?.finish();
		await settle();
		r.setPlayBusy(true);
		r.report({ moves: [landed("d2d4", false)] });
		answer(["d2d4"]);
		clock.advance(REVIEW.landedWaitMs);
		await settle();
		expect(effects()).toHaveLength(0);
		r.setPlayBusy(false);
		await settle();
		expect(effects()).toHaveLength(1);
		expect(effects()[0]).toMatchObject({ effects: [], quality: { quality: "book" } });
		r.dispose();
	});

	it.each(["cancel", "dispose"] as const)(
		"%s while paused does not resurrect ratings on resume",
		async (action) => {
			const { r, effects, searches } = setup();
			r.setPlayBusy(true);
			r.report({ moves: [landed("e2e4", true)] });
			r[action]();
			r.setPlayBusy(false);
			await settle();
			expect(searches).toHaveLength(0);
			expect(effects()).toHaveLength(1);
			expect(effects()[0]?.quality).toBeUndefined();
			r.dispose();
		}
	);

	it("publishes a mating chip while paused, before an immediate game-end cancellation", () => {
		const { r, effects, searches } = setup();
		const fen = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1";
		r.setPlayBusy(true);
		r.report({
			moves: [{ beforeFen: fen, historyFen: fen, historyMoves: [], uci: "a1a8", ply: 0, mine: false }],
		});
		r.cancel();
		expect(effects()).toHaveLength(2);
		expect(effects()[1]?.quality).toMatchObject({ square: "a8", quality: "mate" });
		expect(searches).toHaveLength(0);
		r.setPlayBusy(false);
		expect(effects()).toHaveLength(2);
		r.dispose();
	});

	it("publishes a forced move while paused without invoking the classifier or engine", () => {
		const { r, effects, searches } = setup();
		const fen = "k7/2R5/1K6/8/8/8/8/8 b - - 0 1";
		const classify = spyOn(moveQuality, "classifyMoveQuality");
		try {
			r.setPlayBusy(true);
			r.report({
				moves: [
					{ beforeFen: fen, historyFen: fen, historyMoves: [], uci: "a8b8", ply: 0, mine: false },
				],
			});
			expect(effects().at(-1)?.quality).toMatchObject({ square: "b8", quality: "forced" });
			expect(searches).toHaveLength(0);
			expect(classify).not.toHaveBeenCalled();
		} finally {
			classify.mockRestore();
			r.dispose();
		}
	});
});

describe("BoardEffectsReporter · review scheduling", () => {
	it("remembers an exhausted shallow search without repeatedly queuing it", async () => {
		const { r, open, searches, effects } = setup();
		r.report({ moves: [landed("e2e4", true)] });
		const search = open([]);
		search?.update(9, [line(1, "e2e4", { cp: 30 }, 9)]);
		search?.finish();
		await settle();
		expect(r.frameFor(START)?.depth).toBe(9);
		// It may still exhaust the independent after-position, but neither position loops.
		const after = open(["e2e4"]);
		after?.update(9, [line(1, "e7e5", { cp: 0 }, 9)]);
		after?.finish();
		await settle();
		expect(searches).toHaveLength(2);
		expect(searches.filter((search) => (search.req.moves ?? []).length === 0)).toHaveLength(1);
		expect(effects().some((effect) => effect.quality !== undefined)).toBe(false);
		r.dispose();
	});
	it("does not repopulate frames when a cancelled review settles", async () => {
		const { r, open } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		r.cancel();
		await settle();
		expect(r.frameFor(START)).toBeNull();
		r.dispose();
	});
	it("does not reuse a frame across a repeated board with a different halfmove clock", async () => {
		const { r, open } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		await settle();
		expect(r.frameFor(START)).not.toBeNull();
		expect(r.frameFor(START.replace("0 1", "8 5"))).toBeNull();
		r.dispose();
	});
	it("waits for tactical depth before finalizing a shallow sacrifice candidate", async () => {
		const { r, effects, open, clock } = setup();
		const fen = "4k3/5p2/8/6N1/8/8/8/4K3 w - - 0 1";
		r.report({
			moves: [{ beforeFen: fen, historyFen: fen, historyMoves: [], uci: "g5e6", ply: 0, mine: true }],
		});
		const search = open([]);
		search?.update(12, [line(1, "g5e6", { cp: 300 }, 12), line(2, "g5f3", { cp: 40 }, 12)]);
		await settle();
		clock.advance(REVIEW.landedWaitMs);
		expect(effects().some((effect) => effect.quality !== undefined)).toBe(false);
		search?.update(18, [line(1, "g5e6", { cp: 300 }), line(2, "g5f3", { cp: 40 })]);
		await settle();
		expect(effects().at(-1)?.quality?.quality).toBe("brilliant");
		r.dispose();
	});
	it("off: report posts the rays of each move with no quality and reviews nothing", () => {
		const { r, posts, searches } = setup({ chips: false });
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		r.prepare({ beforeFen: START, history: { fen: START, moves: [] }, uci: "e2e4", ply: 0 });
		r.report({ moves: [landed("e2e4", true)] });
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ kind: "effects", mine: true });
		expect("quality" in (posts[0] as Record<string, unknown>)).toBe(false);
		expect(searches).toHaveLength(0);
		expect(r.stats().delivered).toBe(0);
		r.dispose();
	});

	it("reviews the current position at once, at the review shape and full strength", () => {
		const { r, searches } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		expect(searches).toHaveLength(1);
		const req = searches[0]?.req;
		expect(req).toMatchObject({
			fen: START,
			multiPv: REVIEW.multiPv,
			limit: { depth: REVIEW.targetDepth, movetimeMs: REVIEW.movetimeMs },
			priority: "ponder",
		});
		expect(req?.elo).toBeUndefined();
		expect(req?.moves).toBeUndefined();
		r.dispose();
	});

	it("yields before classifying reviewed frames and sends rays immediately", async () => {
		const { r, effects, open } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		open([])?.finish();
		await settle();
		// The likeliest replies' positions are reviewed next, without being asked.
		expect(open(["e2e4"])?.req.priority).toBe("panel");
		r.report({ moves: [landed("e2e4", false)] });
		expect(effects()).toHaveLength(1);
		expect(effects()[0]?.quality).toBeUndefined();
		await settle();
		expect(effects()).toHaveLength(2);
		expect(effects()[1]?.quality).toEqual({ square: "e4", quality: "best" });
		expect(r.stats().delivered).toBe(1);
		r.dispose();
	});

	it("reviews the position a surprising move made first, and repeats the effects with the chip", async () => {
		const { r, effects, open } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		open([])?.finish();
		await settle();
		const speculative = open(["e2e4"]);
		r.report({ moves: [landed("a2a3", false)] });
		expect(effects()).toHaveLength(1);
		expect(effects()[0]?.quality).toBeUndefined();
		await settle();
		expect(speculative?.stopped).toBe(true);
		const after = open(["a2a3"]);
		expect(after?.req.priority).toBe("move");
		after?.update(REVIEW.targetDepth, [line(1, "e7e5", { cp: -10 })]);
		await settle();
		expect(effects()).toHaveLength(2);
		expect(effects()[1]?.effects).toEqual([]);
		expect(effects()[1]?.quality).toEqual({ square: "a3", quality: "excellent" });
		r.dispose();
	});

	it("publishes from a shallower frame once the landed wait is over", async () => {
		const { r, effects, open, clock } = setup();
		r.report({ moves: [landed("e2e4", true)] });
		const before = open([]);
		expect(before?.req.priority).toBe("move");
		before?.update(
			REVIEW.publishDepth,
			startLines().map((l) => ({ ...l, depth: REVIEW.publishDepth }))
		);
		await settle();
		expect(effects().filter((e) => e.quality)).toHaveLength(0);
		clock.advance(REVIEW.landedWaitMs);
		await settle();
		expect(effects().filter((e) => e.quality)).toHaveLength(1);
		expect(effects().at(-1)?.quality).toEqual({ square: "e4", quality: "best" });
		r.dispose();
	});

	it("reviews our planned move's result while we wait, and ships its chip with the move", async () => {
		const { r, effects, open } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		open([])?.finish();
		await settle();
		r.prepare({ beforeFen: START, history: { fen: START, moves: [] }, uci: "g1f3", ply: 0 });
		await settle();
		expect(open(["g1f3"])?.req.priority).toBe("panel");
		r.report({ moves: [landed("g1f3", true)] });
		expect(effects().at(-1)?.quality).toEqual({ square: "f3", quality: "excellent" });
		r.dispose();
	});

	it("retries a failed review within a second, backing off further only while it keeps failing", async () => {
		// The owner's log (2026-09-15): two crashed boots of the full build each cost 30 s of ratings.
		const { r, searches, open, clock } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.finish("failed");
		await settle();
		// Not again at once …
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		expect(searches).toHaveLength(1);
		// … but within a second.
		clock.advance(1_000);
		await settle();
		expect(searches).toHaveLength(2);
		// A second failure in a row waits longer than the first.
		open([])?.finish("failed");
		await settle();
		clock.advance(1_000);
		await settle();
		expect(searches).toHaveLength(2);
		clock.advance(30_000);
		await settle();
		expect(searches).toHaveLength(3);
		r.dispose();
	});

	it("boots the review engine ahead of play, but not with chips off or while backing off", async () => {
		const on = setup();
		on.r.warm();
		expect(on.reviewer.warms).toBe(1);
		expect(on.searches).toHaveLength(0);
		on.r.observe({ fen: START, history: { fen: START, moves: [] } });
		on.open([])?.finish("failed");
		await settle();
		on.r.warm();
		expect(on.reviewer.warms).toBe(1);
		on.r.dispose();

		const off = setup({ chips: false });
		off.r.warm();
		expect(off.reviewer.warms).toBe(0);
		off.r.dispose();
	});

	it("rates theory from the opening books as book", async () => {
		const { r, effects, open } = setup({ bookMoves: async () => ["d2d4"] });
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		open([])?.finish();
		await settle();
		r.report({ moves: [landed("d2d4", false)] });
		await settle();
		expect(effects().find((e) => e.quality)?.quality).toEqual({ square: "d4", quality: "book" });
		r.dispose();
	});
});

describe("BoardEffectsReporter · whose ratings show", () => {
	// Owner, 2026-09-15: "Show ratings for: You – Enemy – Both". Only the chip (and so its sound)
	// is filtered; the effects of every move still go out.
	const EXCHANGE = ["e2e4", "d7d5"];
	const TAKE = "e4d5";

	/** The position after 1.e4 d5 reviewed ahead of time, then exd5 landing as `mine`'s move. */
	async function landCapture(side: MoveQualityChipSide, mine: boolean) {
		const t = setup({ chipsFor: () => side });
		const fen = applyMoves(START, EXCHANGE) ?? START;
		t.r.observe({ fen, history: { fen: START, moves: EXCHANGE } });
		t.open(EXCHANGE)?.update(REVIEW.targetDepth, [
			line(1, TAKE, { cp: 40 }),
			line(2, "b1c3", { cp: 30 }),
			line(3, "e4e5", { cp: 25 }),
		]);
		t.open(EXCHANGE)?.finish();
		await settle();
		t.r.report({ moves: [landed(TAKE, mine, EXCHANGE)] });
		t.clock.advance(REVIEW.landedWaitMs);
		await settle();
		return { ...t, fen };
	}

	it.each([
		["mine", true, true],
		["mine", false, false],
		["theirs", true, false],
		["theirs", false, true],
		["both", true, true],
		["both", false, true],
	] as const)("%s: a move with mine=%s carries a chip: %s", async (side, mine, shown) => {
		const { r, effects, fen } = await landCapture(side, mine);
		// The effects go out either way — the capture included — flagged with the mover's side.
		expect(effects()).toHaveLength(shown ? 2 : 1);
		expect(effects()[0]?.quality).toBeUndefined();
		const posted = effects().at(-1);
		expect(posted?.mine).toBe(mine);
		expect(effects()[0]?.effects).toEqual(boardEffectsFor({ fen, uci: TAKE }));
		expect(effects()[0]?.effects.some((e) => e.kind === "capture")).toBe(true);
		if (shown) expect(posted?.effects).toEqual([]);
		if (shown) expect(posted?.quality?.square).toBe("d5");
		else expect(posted && "quality" in posted).toBe(false);
		// A hidden side's move is neither delivered nor a missing chip.
		expect(r.stats()).toEqual({ delivered: shown ? 1 : 0, dropped: {} });
		r.dispose();
	});

	it("theirs: our planned move's result is still reviewed while we wait, and its landing posts no chip", async () => {
		const { r, effects, open } = setup({ chipsFor: () => "theirs" });
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		open([])?.finish();
		await settle();
		// b1c3 is not one of the review's top lines, so only the plan asks for its result: the
		// position the opponent's next move is played from.
		r.prepare({ beforeFen: START, history: { fen: START, moves: [] }, uci: "b1c3", ply: 0 });
		await settle();
		expect(open(["b1c3"])?.req.priority).toBe("panel");
		r.report({ moves: [landed("b1c3", true)] });
		expect(effects()).toHaveLength(1);
		expect(effects()[0]).toMatchObject({ kind: "effects", mine: true });
		expect("quality" in (effects()[0] as Record<string, unknown>)).toBe(false);
		expect(r.stats()).toEqual({ delivered: 0, dropped: {} });
		r.dispose();
	});

	it("a side hidden after its move landed gets no late chip, and nothing is counted", async () => {
		let side: MoveQualityChipSide = "both";
		const { r, effects, open, clock } = setup({ chipsFor: () => side });
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, startLines());
		open([])?.finish();
		await settle();
		r.report({ moves: [landed("a2a3", false)] });
		await settle();
		const after = open(["a2a3"]);
		expect(after?.req.priority).toBe("move");
		side = "mine";
		after?.update(REVIEW.targetDepth, [line(1, "e7e5", { cp: -10 })]);
		await settle();
		clock.advance(REVIEW.landedWaitMs);
		await settle();
		expect(effects()).toHaveLength(1);
		expect(effects()[0]?.quality).toBeUndefined();
		expect(r.stats()).toEqual({ delivered: 0, dropped: {} });
		r.dispose();
	});
});

// ── board effects off, move ratings on (owner, 2026-09-15: the switches are independent) ───────
describe("BoardEffectsReporter · rays off", () => {
	const EXCHANGE = ["e2e4", "d7d5"];
	const TAKE = "e4d5";

	it("ships the chip beside an empty effect list, even for a move with rays of its own", async () => {
		const fen = applyMoves(START, EXCHANGE) ?? START;
		// The move does produce effects: they are what the gate strips.
		expect(boardEffectsFor({ fen, uci: TAKE }).length).toBeGreaterThan(0);
		const t = setup({ rays: false });
		t.r.observe({ fen, history: { fen: START, moves: EXCHANGE } });
		t.open(EXCHANGE)?.update(REVIEW.targetDepth, [
			line(1, TAKE, { cp: 40 }),
			line(2, "b1c3", { cp: 30 }),
			line(3, "e4e5", { cp: 25 }),
		]);
		t.open(EXCHANGE)?.finish();
		await settle();
		t.r.report({ moves: [landed(TAKE, true, EXCHANGE)] });
		await settle();
		expect(t.effects()).toHaveLength(1);
		expect(t.effects()[0]?.effects).toEqual([]);
		expect(t.effects()[0]?.quality?.square).toBe("d5");
		expect(t.r.stats().delivered).toBe(1);
		t.r.dispose();
	});

	it("posts nothing while a landed move's rating is still open, then the chip on its own", async () => {
		const { r, effects, open, clock } = setup({ rays: false });
		r.report({ moves: [landed("e2e4", true)] });
		// With the rays on this would already have posted the effect list; there is nothing to draw.
		expect(effects()).toHaveLength(0);
		open([])?.update(
			REVIEW.publishDepth,
			startLines().map((l) => ({ ...l, depth: REVIEW.publishDepth }))
		);
		await settle();
		clock.advance(REVIEW.landedWaitMs);
		await settle();
		expect(effects()).toHaveLength(1);
		expect(effects()[0]?.effects).toEqual([]);
		expect(effects()[0]?.quality?.square).toBe("e4");
		r.dispose();
	});

	it("both off: nothing is posted and nothing is reviewed", () => {
		const { r, posts, searches } = setup({ chips: false, rays: false });
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		r.prepare({ beforeFen: START, history: { fen: START, moves: [] }, uci: "e2e4", ply: 0 });
		r.report({ moves: [landed("e2e4", true)] });
		expect(posts).toEqual([]);
		expect(searches).toHaveLength(0);
		r.dispose();
	});
});

describe("BoardEffectsReporter · forced move", () => {
	it("ships the only legal move's chip with the move, reviewing nothing for it", () => {
		const onlyMove = "k7/2R5/1K6/8/8/8/8/8 b - - 0 1";
		const { r, effects, searches } = setup();
		r.report({
			moves: [
				{
					beforeFen: onlyMove,
					historyFen: onlyMove,
					historyMoves: [],
					uci: "a8b8",
					ply: 0,
					mine: false,
				},
			],
		});
		expect(effects()).toHaveLength(2);
		expect(effects()[1]?.quality).toEqual({ square: "b8", quality: "forced" });
		expect(searches).toHaveLength(0);
		expect(r.stats().delivered).toBe(1);
		r.dispose();
	});
});

describe("BoardEffectsReporter · forced mate", () => {
	/** The pitches a mover's successive `mate` ratings play at, `mateIn` per move. */
	const sequence = (mateIns: readonly number[]): number[] => {
		const played: number[] = [];
		let previous: MateNote | undefined;
		for (const mateIn of mateIns) {
			const semitones = mateSemitones(mateIn, previous);
			played.push(semitones);
			previous = { mateIn, semitones };
		}
		return played;
	};

	it("pitches a mate in 6 at −2, −1, 0, +1, +2 and the checkmate at +3", () => {
		// Owner, 2026-09-15: "pitch = +3 semitones from base at the move that causes checkmate".
		expect(sequence([6, 5, 4, 3, 2, 1])).toEqual([-2, -1, 0, 1, 2, 3]);
		expect(matePitch(1)).toBe(MOVE_QUALITY.mateTopSemitones);
		expect(MOVE_QUALITY.mateTopSemitones).toBe(3);
		expect(MOVE_QUALITY.mateSemitoneStep).toBe(1);
		expect(MOVE_QUALITY.mateMinSemitones).toBe(-12);
	});

	it("plays a tangential move halfway to the next step, and repeated ones rise without passing it", () => {
		const played = sequence([3, 3, 3, 3, 3, 3]);
		expect(played.slice(0, 3)).toEqual([1, 1.5, 1.75]);
		for (let i = 1; i < played.length; i++) {
			expect(played[i] as number).toBeGreaterThan(played[i - 1] as number);
			expect(played[i] as number).toBeLessThanOrEqual(matePitch(2));
		}
		// Progress lands on the step itself; mate growing further away restarts at its own pitch.
		expect(sequence([3, 3, 2])).toEqual([1, 1.5, 2]);
		expect(sequence([3, 3, 5])).toEqual([1, 1.5, -1]);
		// The checkmate is the top step whatever came before it.
		expect(mateSemitones(1, { mateIn: 1, semitones: MOVE_QUALITY.mateMinSemitones })).toBe(3);
		expect(sequence([4, 4, 1]).at(-1)).toBe(3);
	});

	it("holds a long mate at −12 and rises from there to +3", () => {
		const played = sequence(Array.from({ length: 20 }, (_, i) => 20 - i));
		// Mate in 20 … 16 would be −16 … −12: clamped at the floor.
		expect(played.slice(0, 5)).toEqual([-12, -12, -12, -12, -12]);
		expect(played[5]).toBe(-11);
		expect(Math.min(...played)).toBe(MOVE_QUALITY.mateMinSemitones);
		for (let i = 1; i < played.length; i++)
			expect(played[i] as number).toBeGreaterThanOrEqual(played[i - 1] as number);
		expect(played.at(-1)).toBe(3);
		// A tangential move at the floor stays on it.
		expect(sequence([20, 20])).toEqual([-12, -12]);
	});

	it("sounds the checkmating move on the top step the moment it lands, with no review frame", () => {
		// Scholar's mate: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#.
		const history = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6"];
		const { r, effects, searches } = setup();
		r.report({ moves: [landed("h5f7", true, history)] });
		expect(effects()).toHaveLength(2);
		expect(effects()[0]?.quality).toBeUndefined();
		expect(effects()[1]?.quality).toEqual({
			square: "f7",
			quality: "mate",
			mateSemitones: MOVE_QUALITY.mateTopSemitones,
		});
		expect(searches).toHaveLength(0);
		expect(r.stats()).toEqual({ delivered: 1, dropped: {} });
		r.dispose();
	});

	it("carries each move's pitch on its mark, a tangential move halfway up", async () => {
		const { r, effects, open } = setup();
		const rate = async (history: string[], uci: string, mate: number) => {
			const fen = applyMoves(START, history) ?? START;
			r.observe({ fen, history: { fen: START, moves: history } });
			await settle();
			open(history)?.update(REVIEW.targetDepth, [line(1, uci, { mate }), line(2, "d2d4", { cp: 0 })]);
			open(history)?.finish();
			await settle();
			r.report({ moves: [landed(uci, true, history)] });
			await settle();
			return effects().at(-1)?.quality;
		};
		expect(await rate([], "e2e4", 3)).toEqual({ square: "e4", quality: "mate", mateSemitones: 1 });
		expect(await rate(["e2e4", "e7e5"], "g1f3", 3)).toEqual({
			square: "f3",
			quality: "mate",
			mateSemitones: 1.5,
		});
		expect(await rate(["e2e4", "e7e5", "g1f3", "b8c6"], "f1c4", 2)).toEqual({
			square: "c4",
			quality: "mate",
			mateSemitones: 2,
		});
		r.dispose();
	});

	it("rates each move of the sequence mate, carrying its pitch", async () => {
		const { r, effects, open } = setup();
		r.observe({ fen: START, history: { fen: START, moves: [] } });
		open([])?.update(REVIEW.targetDepth, [line(1, "e2e4", { mate: 2 }), line(2, "d2d4", { cp: 0 })]);
		open([])?.finish();
		await settle();
		r.report({ moves: [landed("e2e4", true)] });
		await settle();
		expect(effects().at(-1)?.quality).toEqual({ square: "e4", quality: "mate", mateSemitones: 2 });
		const history = ["e2e4", "e7e5"];
		const fen = applyMoves(START, history) ?? START;
		r.observe({ fen, history: { fen: START, moves: history } });
		await settle();
		open(history)?.update(REVIEW.targetDepth, [
			line(1, "d1h5", { mate: 1 }),
			line(2, "d2d4", { cp: 0 }),
		]);
		open(history)?.finish();
		await settle();
		r.report({ moves: [landed("d1h5", true, history)] });
		await settle();
		expect(effects().at(-1)?.quality).toEqual({ square: "h5", quality: "mate", mateSemitones: 3 });
		r.dispose();
	});
});

describe("persistent move-log reviews", () => {
	it("catches up every ply after the live window, independently of chip side, without old effects", async () => {
		const ratings: MoveListRating[] = [];
		const h = setup({
			annotate: (rating) => ratings.push(rating),
			chipsFor: () => "mine",
			rays: false,
		});
		const moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"];
		h.r.setPlayBusy(true);
		for (const [i, uci] of moves.entries())
			h.r.report({ moves: [landed(uci, i % 2 === 0, moves.slice(0, i))] });
		h.r.finish();
		h.r.setPlayBusy(false);
		for (let guard = 0; guard < 20 && ratings.length < moves.length; guard++) {
			await settle();
			if (ratings.length === moves.length) break;
			const search = h.searches.find((s) => !s.done);
			expect(search).toBeDefined();
			if (!search) break;
			const index = search.req.moves?.length ?? 0;
			search.update(REVIEW.targetDepth, [line(1, moves[index] ?? "d2d3", { cp: 20 })]);
			search.finish();
		}
		await settle();
		expect(ratings.map((r) => r.ply).sort()).toEqual([0, 1, 2, 3, 4, 5]);
		expect(ratings.find((r) => r.ply === 2)?.san).toBe("Nf3");
		expect(h.effects()).toEqual([]);
		expect(h.searches.every((s) => s.req.priority === "panel")).toBe(true);
		h.r.backfill(
			{ fen: applyMoves(START, moves) ?? START, history: { fen: START, moves } },
			moves.length
		);
		await settle();
		expect(ratings).toHaveLength(6);
		h.r.dispose();
	});

	it("backfills an attached game's history once and preempts it for a fresh move", async () => {
		const ratings: MoveListRating[] = [];
		const h = setup({ annotate: (r) => ratings.push(r), rays: false });
		const moves = ["e2e4", "e7e5", "g1f3"];
		const position = { fen: applyMoves(START, moves) ?? START, history: { fen: START, moves } };
		h.r.backfill(position, 3);
		await settle();
		const old = h.open([]);
		expect(old?.req.priority).toBe("panel");
		h.r.backfill(position, 3);
		expect(h.searches).toHaveLength(1);
		h.r.report({ moves: [landed("b8c6", false, moves)] });
		await settle();
		expect(old?.stopped).toBe(true);
		expect(h.open(moves)?.req.priority).toBe("move");
		h.r.cancel();
		await settle();
		expect(ratings).toEqual([]);
		expect(h.searches.filter((s) => !s.done)).toEqual([]);
		h.r.dispose();
	});

	it("publishes a hidden side's rating only to the log", async () => {
		const ratings: MoveListRating[] = [];
		const h = setup({ annotate: (r) => ratings.push(r), chipsFor: () => "theirs", rays: false });
		h.r.report({ moves: [landed("e2e4", true)] });
		h.open([])?.update(REVIEW.targetDepth, startLines());
		h.open([])?.finish();
		await settle();
		expect(ratings).toEqual([{ ply: 0, san: "e4", quality: "best" }]);
		expect(h.effects()).toEqual([]);
		h.r.dispose();
	});
});

it("reuses a completed log verdict when the same live move gains late board metadata", async () => {
	const ratings: MoveListRating[] = [];
	const h = setup({ annotate: (r) => ratings.push(r), rays: false });
	const moves = ["e2e4"];
	h.r.backfill({ fen: applyMoves(START, moves) ?? START, history: { fen: START, moves } }, 1);
	h.open([])?.update(REVIEW.targetDepth, startLines());
	h.open([])?.finish();
	await settle();
	expect(ratings).toHaveLength(1);
	expect(h.effects()).toEqual([]);
	h.r.report({ moves: [landed("e2e4", true)] });
	expect(h.effects()).toHaveLength(1);
	expect(h.effects()[0]?.quality).toMatchObject({ square: "e4", quality: "best" });
	expect(ratings).toHaveLength(1);
	h.r.dispose();
});

it("reviews missed real moves before speculative replies once the live position is ready", async () => {
	const h = setup({ annotate: () => {}, rays: false });
	const moves = ["e2e4", "e7e5", "g1f3"];
	const position = { fen: applyMoves(START, moves) ?? START, history: { fen: START, moves } };
	h.r.setPlayBusy(true);
	h.r.backfill(position, 3);
	h.r.observe(position);
	h.r.setPlayBusy(false);
	const current = h.open(moves);
	expect(current?.req.priority).toBe("ponder");
	current?.update(REVIEW.targetDepth, [line(1, "b8c6", { cp: 20 })]);
	current?.finish();
	await settle();
	expect(h.open([])?.req.priority).toBe("panel");
	expect(h.open([...moves, "b8c6"])).toBeUndefined();
	h.r.dispose();
});

describe("BoardEffectsReporter · tablebase move", () => {
	const KRK = "8/8/8/4k3/8/8/2K5/7R w - - 0 1";
	const krkMove = (uci: string): LandedMove => ({
		beforeFen: KRK,
		historyFen: KRK,
		historyMoves: [],
		uci,
		ply: 0,
		mine: true,
	});

	it("rates our tablebase move Book the moment it lands, with no review frame", async () => {
		const { r, effects } = setup();
		r.prepare({
			beforeFen: KRK,
			history: { fen: KRK, moves: [] },
			uci: "c2c3",
			ply: 0,
			tablebase: true,
		});
		r.report({ moves: [krkMove("c2c3")] });
		await settle();
		const chips = effects().filter((e) => e.quality !== undefined);
		expect(chips).toHaveLength(1);
		expect(chips[0]?.quality).toEqual({ square: "c3", quality: "book" });
		r.dispose();
	});

	it("leaves the same move without the flag to the review", async () => {
		const { r, effects } = setup();
		r.prepare({ beforeFen: KRK, history: { fen: KRK, moves: [] }, uci: "c2c3", ply: 0 });
		r.report({ moves: [krkMove("c2c3")] });
		await settle();
		expect(effects().filter((e) => e.quality !== undefined)).toHaveLength(0);
		r.dispose();
	});

	it("keeps the mate chip for a tablebase move that checkmates", async () => {
		const mateFen = "k7/8/1K6/8/8/8/8/7R w - - 0 1";
		const { r, effects } = setup();
		r.prepare({
			beforeFen: mateFen,
			history: { fen: mateFen, moves: [] },
			uci: "h1h8",
			ply: 0,
			tablebase: true,
		});
		r.report({
			moves: [
				{ beforeFen: mateFen, historyFen: mateFen, historyMoves: [], uci: "h1h8", ply: 0, mine: true },
			],
		});
		await settle();
		const chips = effects().filter((e) => e.quality !== undefined);
		expect(chips[0]?.quality?.quality).toBe("mate");
		r.dispose();
	});
});
