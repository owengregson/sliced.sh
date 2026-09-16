// test/service/game-session/max-strength.test.ts — max-strength mode's deep move search (owner,
// 2026-09-15: "the deepest thought we can"): its window, its request, how its answer replaces the
// move, and the resign rule over its single-line frame.
import { describe, expect, it } from "bun:test";
import { MAX_STRENGTH } from "@core/constants/max-strength";
import { RESIGN } from "@core/constants/resign";
import type { AnalysisHandle, AnalysisResult, AnalysisUpdate } from "@core/engine/types";
import {
	deepenRecommendation,
	deepSearchRequest,
	deepSearchWindowMs,
	startDeepSearch,
} from "@service/game-session/max-strength";
import { isResignableFrame } from "@service/game-session/resign-frame";
import type { EvalLine } from "@typedefs/engine";
import type { Recommendation } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const NOW = 1_700_000_000_000;

function plan(thinkMs: number, approachMs = 800): TimingPlan {
	const phase = (thinkMs - approachMs) / 4;
	return {
		thinkMs,
		mode: "normal",
		preMoveHoverMs: thinkMs - approachMs,
		dragDurationMs: approachMs / 2,
		deadlineMs: NOW + thinkMs,
		rationale: [],
		features: {},
		orientationMs: phase,
		window: {
			orientationMs: phase,
			scanMs: phase,
			previewMs: phase,
			decisionMs: phase,
			approachMs,
		},
	};
}

function evalLine(uci: string, cp: number, multipv: number, depth: number): EvalLine {
	return { multipv, score: { cp }, depth, pvUci: [uci], pvSan: [uci] };
}

function rec(overrides: Partial<Recommendation> = {}): Recommendation {
	return {
		chosen: {
			uci: "e2e4",
			san: "e4",
			from: "e2",
			to: "e4",
			source: "engine-elo",
			rankInLines: 1,
			rationale: ["max strength: the engine's best move (target 3800)"],
		},
		lines: [evalLine("e2e4", 30, 1, 14), evalLine("d2d4", 20, 2, 14), evalLine("g1f3", 10, 3, 14)],
		eval: { cp: 30 },
		wdl: [400, 500, 100],
		depth: 14,
		nps: 1_000_000,
		plan: plan(10_000),
		computedAt: NOW,
		fen: START,
		...overrides,
	};
}

function result(lines: EvalLine[], bestmove: string | null, depth: number): AnalysisResult {
	const request = deepSearchRequest({ fen: START, targetElo: 3800, windowMs: 5_000 });
	return {
		id: request.id,
		request,
		bestmove,
		status: "complete",
		final: { id: request.id, depth, lines, nodes: 1, nps: 2_000_000, timeMs: 5_000, complete: true },
	};
}

describe("deepSearchWindowMs", () => {
	const base = {
		nowMs: NOW + 1_000,
		searchStartedAtMs: NOW,
		plan: plan(10_000),
		myClockMs: 300_000,
	};

	it("runs until the hand must start its approach, so the move lands on the planned deadline", () => {
		const windowMs = deepSearchWindowMs(base);
		expect(windowMs).toBe(10_000 - 800 - MAX_STRENGTH.handReserveMs - 1_000);
		expect(base.nowMs + windowMs + MAX_STRENGTH.handReserveMs + base.plan.window.approachMs).toBe(
			base.plan.deadlineMs
		);
		// An untimed game has no clock bound: the same window.
		expect(deepSearchWindowMs({ ...base, myClockMs: 0 })).toBe(windowMs);
	});

	it("keeps the clock fraction, counted from the moment the position's search began", () => {
		// 10 % of a 40 s clock is 4 s from the start of the search, 3 s from now.
		expect(deepSearchWindowMs({ ...base, myClockMs: 40_000 })).toBe(3_000);
		expect(deepSearchWindowMs({ ...base, myClockMs: 12_000 })).toBe(0);
	});

	it("keeps a clock race's search cap", () => {
		expect(deepSearchWindowMs({ ...base, raceMaxSearchMs: 1_500 })).toBe(500);
		expect(deepSearchWindowMs({ ...base, raceMaxSearchMs: 1_200 })).toBe(0);
	});

	it("starts nothing when the plan leaves less than the minimum search", () => {
		const late = base.plan.deadlineMs - 800 - MAX_STRENGTH.handReserveMs - MAX_STRENGTH.minSearchMs;
		expect(deepSearchWindowMs({ ...base, nowMs: late })).toBe(MAX_STRENGTH.minSearchMs);
		expect(deepSearchWindowMs({ ...base, nowMs: late + 1 })).toBe(0);
		expect(deepSearchWindowMs({ ...base, plan: plan(1_200) })).toBe(0);
		expect(deepSearchWindowMs({ ...base, nowMs: Number.NaN })).toBe(0);
	});
});

describe("deepSearchRequest", () => {
	it("is one line at full strength, no depth ceiling of its own, at move priority", () => {
		const history = { fen: START, moves: ["e2e4", "e7e5"] };
		const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
		const req = deepSearchRequest({ fen, history, targetElo: 3800, windowMs: 7_000 });
		expect(req).toMatchObject({
			fen: START,
			moves: ["e2e4", "e7e5"],
			multiPv: MAX_STRENGTH.multiPv,
			limit: { movetimeMs: 7_000, depth: MAX_STRENGTH.searchDepth },
			targetElo: 3800,
			priority: "move",
		});
		expect(req.elo).toBeUndefined();
		expect(req.searchmoves).toBeUndefined();
		// A history that does not reach the board is not invented.
		const bare = deepSearchRequest({
			fen,
			history: { fen: START, moves: ["d2d4"] },
			targetElo: 3800,
			windowMs: 1,
		});
		expect(bare.fen).toBe(fen);
		expect(bare.moves).toBeUndefined();
	});
});

describe("deepenRecommendation", () => {
	it("replaces the move with a deeper search's bestmove and leads the lines with its line", () => {
		const standing = rec();
		const deep = deepenRecommendation(standing, result([evalLine("d2d4", 45, 1, 24)], "d2d4", 24));
		expect(deep).not.toBeNull();
		const next = deep?.rec;
		expect(next?.chosen).toMatchObject({ uci: "d2d4", from: "d2", to: "d4", source: "engine-elo" });
		expect(next?.chosen.rankInLines).toBe(1);
		expect(next?.chosen.rationale.join(" ")).toContain("depth 24");
		expect(next?.lines.map((l) => [l.pvUci[0], l.multipv])).toEqual([
			["d2d4", 1],
			["e2e4", 2],
			["g1f3", 3],
		]);
		expect(next?.eval).toEqual({ cp: 45 });
		expect(next?.depth).toBe(24);
		expect(next?.nps).toBe(2_000_000);
		expect(next?.wdl).toBeUndefined();
		// The timing model's plan is never touched.
		expect(next?.plan).toBe(standing.plan);
		expect(deep?.frame).toEqual([evalLine("d2d4", 45, 1, 24)]);
	});

	it("keeps the chosen move itself when the deep search confirms it", () => {
		const standing = rec();
		const deep = deepenRecommendation(standing, result([evalLine("e2e4", 35, 1, 22)], "e2e4", 22));
		expect(deep?.rec.chosen).toBe(standing.chosen);
		expect(deep?.rec.depth).toBe(22);
		expect(deep?.rec.lines[0]?.depth).toBe(22);
	});

	it("uses the frame's line when the bestmove is not among its roots", () => {
		const deep = deepenRecommendation(rec(), result([evalLine("g1f3", 40, 1, 20)], "b1c3", 20));
		expect(deep?.rec.chosen.uci).toBe("g1f3");
	});

	it("keeps the standing move for no answer, a shallower frame, a bound or an illegal line", () => {
		const standing = rec();
		expect(deepenRecommendation(standing, null)).toBeNull();
		expect(deepenRecommendation(standing, result([], null, 0))).toBeNull();
		expect(
			deepenRecommendation(standing, result([evalLine("d2d4", 45, 1, 13)], "d2d4", 13))
		).toBeNull();
		const bounded = { ...evalLine("d2d4", 45, 1, 24), bound: "lower" as const };
		expect(deepenRecommendation(standing, result([bounded], "d2d4", 24))).toBeNull();
		expect(
			deepenRecommendation(standing, result([evalLine("e2e5", 45, 1, 24)], "e2e5", 24))
		).toBeNull();
	});
});

describe("startDeepSearch", () => {
	function stoppable(answer: AnalysisResult): { handle: AnalysisHandle; stops: () => number } {
		let resolve: (value: AnalysisResult) => void = () => {};
		const settled = new Promise<AnalysisResult>((done) => {
			resolve = done;
		});
		let stops = 0;
		async function* none(): AsyncGenerator<AnalysisUpdate> {}
		return {
			stops: () => stops,
			handle: {
				id: answer.id,
				updates: none(),
				result: settled,
				stop: () => {
					stops += 1;
					resolve(answer);
					return Promise.resolve();
				},
			},
		};
	}

	it("harvest() ends the search and keeps what it found; abort discards it", async () => {
		const answer = result([evalLine("d2d4", 45, 1, 24)], "d2d4", 24);
		const kept = stoppable(answer);
		const search = startDeepSearch({ analyse: () => kept.handle }, answer.request, {
			deadlineMs: Date.now() + 60_000,
			now: Date.now,
			signal: new AbortController().signal,
		});
		search.harvest();
		expect(await search.result).toBe(answer);
		expect(kept.stops()).toBe(1);

		const dropped = stoppable(answer);
		const ac = new AbortController();
		const cancelled = startDeepSearch({ analyse: () => dropped.handle }, answer.request, {
			deadlineMs: Date.now() + 60_000,
			now: Date.now,
			signal: ac.signal,
		});
		ac.abort();
		expect(await cancelled.result).toBeNull();
		expect(dropped.stops()).toBe(1);
	});
});

describe("isResignableFrame", () => {
	const mated = (mate: number, multipv: number, depth = 20): EvalLine => ({
		multipv,
		score: { mate },
		depth,
		pvUci: ["e2e4"],
		pvSan: ["e4"],
	});

	it("reads a MultiPV frame as before: every line mated within reach, deep enough", () => {
		expect(isResignableFrame([mated(-2, 1), mated(-1, 2), mated(-1, 3)])).toBe(true);
		expect(isResignableFrame([mated(-2, 1), evalLine("d2d4", 50, 2, 20)])).toBe(false);
	});

	it("reads the deep search's single line: its best move mated means every move is", () => {
		expect(isResignableFrame([mated(-RESIGN.maxMateIn, 1)])).toBe(true);
		expect(isResignableFrame([mated(-RESIGN.maxMateIn - 1, 1)])).toBe(false);
		expect(isResignableFrame([mated(-1, 1, RESIGN.minDepth - 1)])).toBe(false);
		expect(isResignableFrame([mated(2, 1)])).toBe(false);
		expect(isResignableFrame([evalLine("e2e4", -900, 1, 30)])).toBe(false);
		expect(isResignableFrame([])).toBe(false);
	});
});
