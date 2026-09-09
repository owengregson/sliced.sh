// test/service/game-session/recommendation.test.ts — Task 30 Step 3: the §3.2 pipeline
// (book → analyse → select → plan) and the §7.5 search-budget policy.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { SEARCH_BUDGET } from "@core/constants/search";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { createRng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import { createSelectionState } from "@core/strength/move-selector";
import { TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import {
	estimatedThinkMs,
	type RecommendationInput,
	RecommendationPipeline,
	searchBudget,
} from "@service/game-session/recommendation";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, PositionSnapshot } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const NOW = 1_700_000_000_000;

function settings(
	patch: Partial<Settings["engine"]> = {},
	timing: Partial<Settings["timing"]> = {}
): Settings {
	return {
		...DEFAULT_SETTINGS,
		engine: { ...DEFAULT_SETTINGS.engine, ...patch },
		timing: { ...DEFAULT_SETTINGS.timing, ...timing },
	};
}

function snapshot(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
	return {
		site: "lichess",
		gameId: "g1",
		fen: START,
		ply: 0,
		sideToMove: "w",
		myColor: "w",
		clocks: { w: { ms: 180_000, running: true }, b: { ms: 180_000, running: false } },
		timeControl: { baseMs: 180_000, incMs: 2_000 },
		capturedAt: NOW,
		...overrides,
	};
}

function lines(uci: string[], depth = 14, cps?: number[]): EvalLine[] {
	return uci.map((u, i) => ({
		multipv: i + 1,
		score: { cp: cps?.[i] ?? 30 - i * 10 },
		depth,
		pvUci: [u],
		pvSan: [u],
	}));
}

/** A fake engine that answers with `result` and records what it was asked. */
function fakeEngine(result: (req: AnalysisRequest) => AnalysisResult | null, elo?: number) {
	const requests: AnalysisRequest[] = [];
	return {
		requests,
		engineElo: () => elo,
		analyse(req: AnalysisRequest): AnalysisHandle {
			requests.push(req);
			const r = result(req);
			const final = r?.final ?? {
				id: req.id,
				depth: 0,
				lines: [],
				nodes: 0,
				nps: 0,
				timeMs: 0,
				complete: true,
			};
			const settled: AnalysisResult = r ?? {
				id: req.id,
				bestmove: null,
				final,
				status: "failed",
				request: req,
			};
			async function* once(): AsyncGenerator<never, void, unknown> {}
			return {
				id: req.id,
				updates: once(),
				result: Promise.resolve(settled),
				stop: () => Promise.resolve(),
			};
		},
	};
}

function analysisOf(
	req: AnalysisRequest,
	uci: string[],
	depth: number,
	cps?: number[]
): AnalysisResult {
	const final = {
		id: req.id,
		depth,
		lines: lines(uci, depth, cps),
		nodes: 1000,
		nps: 100_000,
		timeMs: 100,
		complete: true,
	};
	return { id: req.id, bestmove: uci[0] ?? null, final, status: "complete", request: req };
}

function input(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
	return {
		snapshot: snapshot(),
		settings: settings(),
		targetElo: 1500,
		persona: "balanced",
		form: 0,
		tau: 0.5,
		moves: [],
		expectedOppReply: null,
		oppThinkMsHistory: [],
		myThinkMsHistory: [],
		selectionState: createSelectionState(),
		budgetUsedRatio: 0,
		rng: createRng("rec-test"),
		nowMs: NOW,
		engineReady: true,
		autoQueen: true,
		inputMethod: "drag",
		...overrides,
	};
}

function model(): TimingModel {
	const m = new TimingModel(new V1ParametricHead(), DEFAULT_SETTINGS.timing, createRng("t"));
	m.startGame({
		targetElo: 1500,
		profile: "balanced",
		baseSec: 180,
		incSec: 2,
		site: "lichess",
		gameId: "g1",
	});
	return m;
}

describe("§7.5 search budget", () => {
	it("tEngine = clamp(0.6 · plannedThinkMs, 150, 4000)", () => {
		expect(searchBudget(1000, "blitz", settings()).movetimeMs).toBe(600);
		expect(searchBudget(10, "blitz", settings()).movetimeMs).toBe(SEARCH_BUDGET.minMovetimeMs);
		expect(searchBudget(100_000, "blitz", settings()).movetimeMs).toBe(SEARCH_BUDGET.maxMovetimeMs);
	});

	it("depthCap follows the speed class and is capped by Settings.engine.depthCap", () => {
		expect(searchBudget(1000, "bullet", settings()).depthCap).toBe(14);
		expect(searchBudget(1000, "blitz", settings()).depthCap).toBe(18);
		expect(searchBudget(1000, "rapid", settings()).depthCap).toBe(22);
		expect(searchBudget(1000, "classical", settings()).depthCap).toBe(22); // settings cap 22
		expect(searchBudget(1000, "classical", settings({ depthCap: 30 })).depthCap).toBe(24);
		expect(searchBudget(1000, "rapid", settings({ depthCap: 10 })).depthCap).toBe(10);
	});

	it("K = 3 / 6 / 8 by budget, never below the user's MultiPV nor above 8", () => {
		expect(searchBudget(100, "bullet", settings({ multiPv: 1 })).multiPv).toBe(3);
		expect(searchBudget(1000, "blitz", settings({ multiPv: 1 })).multiPv).toBe(6);
		expect(searchBudget(9000, "rapid", settings({ multiPv: 1 })).multiPv).toBe(8);
		expect(searchBudget(100, "bullet", settings({ multiPv: 4 })).multiPv).toBe(4);
		expect(searchBudget(9000, "rapid", settings({ multiPv: 8 })).multiPv).toBe(8);
	});

	it("the estimate scales with the clock and the speed knob", () => {
		const base = {
			fen: START,
			ply: 0,
			myClockMs: 180_000,
			baseSec: 180,
			incSec: 2,
			tc: "blitz" as const,
			tau: 0.5,
			budgetUsedRatio: 0,
		};
		const normal = estimatedThinkMs(base, settings());
		const slow = estimatedThinkMs(base, settings({}, { speedScale: 2 }));
		const lowClock = estimatedThinkMs({ ...base, myClockMs: 20_000 }, settings());
		expect(slow).toBeCloseTo(normal * 2, 6);
		expect(lowClock).toBeLessThan(normal);
		expect(normal).toBeGreaterThan(0);
	});
});

describe("recommendation pipeline (§3.2)", () => {
	it("composes book → analyse → select → plan and returns a full Recommendation", async () => {
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4", "g1f3", "c2c4"], 14));
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(input());
		expect(out).not.toBeNull();
		expect(out?.rec.chosen.uci.length).toBe(4);
		expect(out?.rec.lines.length).toBe(4);
		expect(out?.rec.depth).toBe(14);
		expect(out?.rec.fen).toBe(START);
		expect(out?.rec.plan.thinkMs).toBeGreaterThan(0);
		expect(out?.fromBook).toBe(false);
		expect(engine.requests[0]?.priority).toBe("move");
		expect(engine.requests[0]?.limit.movetimeMs).toBe(
			Math.round(out?.budget.movetimeMs ?? Number.NaN)
		);
	});

	it("plays the book move when the book answers and marks the position in book", async () => {
		const book: ChosenMove = {
			uci: "c2c4",
			san: "c4",
			from: "c2",
			to: "c4",
			source: "book",
			rankInLines: 0,
			cpLoss: 0,
			rationale: ["book"],
		};
		const policy: BookPolicy = { bookMove: async () => book, dispose: () => {} };
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "c2c4"], 14));
		const timing = model();
		const pipeline = new RecommendationPipeline({ engine, timing, book: policy });
		const out = await pipeline.run(input());
		expect(out?.rec.chosen.uci).toBe("c2c4");
		expect(out?.fromBook).toBe(true);
		expect(out?.rec.plan.features.in_book).toBe(1);
	});

	it("the trap check vetoes a losing book move from E ≥ 2000 (§7.3)", async () => {
		const book: ChosenMove = {
			uci: "b1a3",
			san: "Na3",
			from: "b1",
			to: "a3",
			source: "book",
			rankInLines: 0,
			cpLoss: 0,
			rationale: [],
		};
		const policy: BookPolicy = { bookMove: async () => book, dispose: () => {} };
		// b1a3 is absent from the lines and the spread is > 0.15 win fraction.
		const engine = fakeEngine((req) => {
			const result = analysisOf(req, ["e2e4", "d2d4"], 14);
			result.final.lines = [
				{ multipv: 1, score: { cp: 600 }, depth: 14, pvUci: ["e2e4"], pvSan: ["e4"] },
				{ multipv: 2, score: { cp: -600 }, depth: 14, pvUci: ["d2d4"], pvSan: ["d4"] },
			];
			return result;
		});
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: policy });
		const out = await pipeline.run(input({ targetElo: 2400, settings: settings() }));
		expect(out?.rec.chosen.uci).not.toBe("b1a3");
		expect(out?.fromBook).toBe(true); // the book did answer; the choice was overridden
	});

	it("retries once with +300 ms when the first search is shallower than depth 8", async () => {
		let call = 0;
		const engine = fakeEngine((req) => {
			call += 1;
			return analysisOf(req, ["e2e4", "d2d4"], call === 1 ? 5 : 12);
		});
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(input());
		expect(engine.requests.length).toBe(2);
		const first = engine.requests[0]?.limit.movetimeMs ?? 0;
		expect(engine.requests[1]?.limit.movetimeMs).toBe(Math.round(first + SEARCH_BUDGET.retryExtraMs));
		expect(out?.rec.depth).toBe(12);
	});

	it("falls back to the top two lines with τ halved below depth 6", async () => {
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4", "g1f3", "c2c4"], 4));
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(input());
		expect(out).not.toBeNull();
		expect(["e2e4", "d2d4"]).toContain(out?.rec.chosen.uci ?? "");
		// The full line set still reaches the panel; only the selector's pool was trimmed.
		expect(out?.rec.lines.length).toBe(4);
	});

	it("nReasonable is the position's `n_reasonable` feature, not the MultiPV count", async () => {
		// Six lines, but only the top two are inside `TIMING_CONSTANTS.features.nReasonableCp`
		// (40 cp) of the best — `K` is a function of the *time budget* (§7.5's 3/6/8 ladder), so
		// reporting it as `n_reasonable` would put a driver of the think time on the complexity
		// axis and make `report.py`'s `ln(hold) vs ln(n_reasonable)` correlation spurious.
		const uci = ["e2e4", "d2d4", "g1f3", "c2c4", "b1c3", "a2a3"];
		const cps = [30, 10, -400, -450, -500, -600];
		const engine = fakeEngine((req) => analysisOf(req, uci, 14, cps));
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(input());
		expect(out).not.toBeNull();
		expect(out?.rec.lines).toHaveLength(uci.length);
		expect(out?.nReasonable).toBe(2);
		expect(out?.nReasonable).not.toBe(out?.rec.lines.length);
		// …and it is exactly what the timing model computed for this position.
		expect(out?.nReasonable).toBe(out?.rec.plan.features.n_reasonable);
	});

	it("returns null when the engine answers nothing and there is no book move", async () => {
		const engine = fakeEngine(() => null);
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		expect(await pipeline.run(input())).toBeNull();
	});

	it("returns null when the caller aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4"], 14));
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		expect(await pipeline.run(input({ signal: ac.signal }))).toBeNull();
	});
});
