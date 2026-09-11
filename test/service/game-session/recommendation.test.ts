// test/service/game-session/recommendation.test.ts — Task 30 Step 3: the §3.2 pipeline
// (book → analyse → select → plan) and the §7.5 search-budget policy.
import { describe, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
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
		site: "chesscom",
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
		site: "chesscom",
		gameId: "g1",
	});
	return m;
}

describe("§6.4 / §7.5 search budget", () => {
	/** A comfortable position: 20 legal moves, a full clock, a long planned wait. */
	const comfortable = (tc: "bullet" | "blitz" | "rapid" | "classical" | "untimed") => ({
		tc,
		myClockMs: 600_000,
		legalMoves: 20,
		plannedThinkMs: 7_500,
	});

	// The old contract was `clamp(0.6 · plannedThinkMs, 150, 4000)`, which made the search as long
	// as the wait: a 7.5 s planned think — what every game planned while the time control never
	// reached the worker — searched the full 4 s cap before any recommendation existed. The budget
	// is now derived from the time control and the position instead; §7.5's own requirement (finish
	// before we act) survives as an upper bound, below.
	it("is plan-independent: the class base, not a fraction of the wait", () => {
		expect(searchBudget(comfortable("bullet"), settings()).movetimeMs).toBe(400);
		expect(searchBudget(comfortable("blitz"), settings()).movetimeMs).toBe(600);
		expect(searchBudget(comfortable("rapid"), settings()).movetimeMs).toBe(1_000);
		expect(searchBudget(comfortable("classical"), settings()).movetimeMs).toBe(1_500);
		expect(searchBudget(comfortable("untimed"), settings()).movetimeMs).toBe(1_500);
		// ten times the wait changes nothing
		const long = { ...comfortable("blitz"), plannedThinkMs: 75_000 };
		expect(searchBudget(long, settings()).movetimeMs).toBe(600);
		// and it is nowhere near the old 4 s
		expect(searchBudget(comfortable("untimed"), settings()).movetimeMs).toBeLessThan(
			SEARCH_BUDGET.maxMovetimeMs
		);
	});

	it("§7.5 still binds when the wait is short: the search finishes before the hand acts", () => {
		// a 400 ms planned wait in a rapid game: 0.6 × 400 = 240 ms, not the class's 1000 ms
		const hurried = { ...comfortable("rapid"), plannedThinkMs: 400 };
		expect(searchBudget(hurried, settings()).movetimeMs).toBeCloseTo(240, 6);
		// and never below the floor
		const instant = { ...comfortable("rapid"), plannedThinkMs: 10 };
		expect(searchBudget(instant, settings()).movetimeMs).toBe(SEARCH_BUDGET.minMovetimeMs);
	});

	it("never spends more than a twentieth of the clock that is left", () => {
		// 4 s left in a blitz game: 200 ms, not the class's 600 ms
		const trouble = { tc: "blitz" as const, myClockMs: 4_000, legalMoves: 20, plannedThinkMs: 7_500 };
		expect(searchBudget(trouble, settings()).movetimeMs).toBeCloseTo(200, 6);
		// an untimed game reports no clock and is not starved by it
		const noClock = { ...comfortable("untimed"), myClockMs: 0 };
		expect(searchBudget(noClock, settings()).movetimeMs).toBe(1_500);
	});

	it("a position with one legal move takes the floor — no search can change the answer", () => {
		const forced = { ...comfortable("classical"), legalMoves: 1 };
		expect(searchBudget(forced, settings()).movetimeMs).toBe(SEARCH_BUDGET.minMovetimeMs);
	});

	it("…but zero legal moves is an unreadable FEN, not a forced move, and keeps the full budget", () => {
		// `legalMoves()` answers `[]` on a FEN chess.js cannot parse (`san.ts`), so `<= 1` would have
		// given the shortest search of all to the position we understand least.
		const unreadable = { ...comfortable("classical"), legalMoves: 0 };
		expect(searchBudget(unreadable, settings()).movetimeMs).toBe(1_500);
	});

	it("depthCap follows the speed class and is capped by Settings.engine.depthCap", () => {
		expect(searchBudget(comfortable("bullet"), settings()).depthCap).toBe(14);
		expect(searchBudget(comfortable("blitz"), settings()).depthCap).toBe(18);
		expect(searchBudget(comfortable("rapid"), settings()).depthCap).toBe(22);
		expect(searchBudget(comfortable("classical"), settings()).depthCap).toBe(22); // settings cap 22
		expect(searchBudget(comfortable("classical"), settings({ depthCap: 30 })).depthCap).toBe(24);
		expect(searchBudget(comfortable("rapid"), settings({ depthCap: 10 })).depthCap).toBe(10);
	});

	it("K = 3 / 6 / 8 by budget, never below the user's MultiPV nor above 8", () => {
		const tiny = { ...comfortable("bullet"), plannedThinkMs: 400 }; // 240 ms → K = 3
		expect(searchBudget(tiny, settings({ multiPv: 1 })).multiPv).toBe(3);
		expect(searchBudget(comfortable("blitz"), settings({ multiPv: 1 })).multiPv).toBe(6);
		expect(searchBudget(comfortable("classical"), settings({ multiPv: 1 })).multiPv).toBe(8);
		expect(searchBudget(tiny, settings({ multiPv: 4 })).multiPv).toBe(4);
		expect(searchBudget(comfortable("classical"), settings({ multiPv: 8 })).multiPv).toBe(8);
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
	it("vetoes an unsearched book repetition when an evaluated continuation preserves the win", async () => {
		const history = {
			fen: "6k1/8/8/8/8/8/PPPP4/6K1 b - - 0 1",
			moves: ["g8h8", "g1h1", "h8g8", "h1g1", "g8h8", "g1h1", "h8g8"],
		};
		const fen = applyMoves(history.fen, history.moves)!;
		const book: ChosenMove = {
			uci: "h1g1",
			san: "Kg1",
			from: "h1",
			to: "g1",
			source: "book",
			rankInLines: 0,
			cpLoss: 0,
			rationale: [],
		};
		const engine = fakeEngine((req) => analysisOf(req, ["a2a3", "a2a4"], 14, [775, 750]));
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: { bookMove: async () => book, dispose: () => {} },
		});
		const out = await pipeline.run(
			input({ snapshot: snapshot({ fen, ply: 7 }), moves: history.moves, history })
		);
		expect(out?.rec.chosen.uci).not.toBe("h1g1");
		expect(out?.rec.chosen.source).not.toBe("book");
	});
	it("passes validated game history to the engine and rejects a stale same-board replay", async () => {
		const moves = ["g1f3", "g8f6", "f3g1", "f6g8"];
		const fen = applyMoves(START, moves)!;
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 14));
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		await pipeline.run(
			input({ snapshot: snapshot({ fen, ply: 4 }), moves, history: { fen: START, moves } })
		);
		expect(engine.requests[0]?.fen).toBe(START);
		expect(engine.requests[0]?.moves).toEqual(moves);
		const twice = applyMoves(START, [...moves, ...moves])!;
		await pipeline.run(
			input({ snapshot: snapshot({ fen: twice, ply: 8 }), moves, history: { fen: START, moves } })
		);
		expect(engine.requests[1]?.fen).toBe(twice);
		expect(engine.requests[1]?.moves).toBeUndefined();
	});
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

	it("retries a shallow early result only within the original search budget", async () => {
		let call = 0;
		const engine = fakeEngine((req) => {
			call += 1;
			return analysisOf(req, ["e2e4", "d2d4"], call === 1 ? 5 : 12);
		});
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(input());
		expect(engine.requests.length).toBe(2);
		const first = engine.requests[0]?.limit.movetimeMs ?? 0;
		expect(engine.requests[1]?.limit.movetimeMs).toBe(Math.round(first - 100));
		expect(out?.rec.depth).toBe(12);
	});

	it("never adds another full search when a shallow result exhausted the original budget", async () => {
		let elapsed = 0;
		const engine = fakeEngine((req) => {
			elapsed += req.limit.movetimeMs ?? 0;
			const result = analysisOf(req, ["e2e4", "d2d4"], 5);
			result.final.timeMs = req.limit.movetimeMs ?? 0;
			return result;
		});
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			now: () => elapsed,
		});
		const out = await pipeline.run(
			input({
				snapshot: snapshot({
					clocks: { w: { ms: 2000, running: true }, b: { ms: 30000, running: false } },
				}),
			})
		);
		expect(out).not.toBeNull();
		expect(engine.requests).toHaveLength(1);
		expect(elapsed).toBeLessThanOrEqual(200);
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

describe("clock-race search and conversion", () => {
	it("caps a shallow race search below150ms and never retries beyond that small budget", async () => {
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 3));
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(
			input({
				snapshot: snapshot({
					timeControl: { baseMs: 600000, incMs: 0 },
					clocks: { w: { ms: 20000, running: true }, b: { ms: 1000, running: false } },
				}),
			})
		);
		expect(out?.rec.chosen.uci).toBeDefined();
		expect(engine.requests).toHaveLength(1);
		expect(engine.requests[0]?.limit.movetimeMs).toBeLessThanOrEqual(100);
		expect(out?.budget.movetimeMs).toBeLessThanOrEqual(100);
	});

	it("returns a legal lone-king fallback when a tiny search has no PV or bestmove", async () => {
		const fen = "7k/8/8/8/8/p7/8/7K w - - 0 1";
		const engine = fakeEngine(() => null);
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(
			input({ snapshot: snapshot({ fen, timeControl: { baseMs: 600000, incMs: 0 } }) })
		);
		expect(out?.rec.chosen.uci).toBeDefined();
		expect(applyMoves(fen, [out?.rec.chosen.uci ?? ""])).not.toBeNull();
		expect(out?.rec.chosen.rationale.join(" ")).toContain("legal lone-king fallback");
		expect(engine.requests).toHaveLength(1);
		expect(out?.budget.movetimeMs).toBe(30);
	});

	it("a shallow third-ranked mate overrides an opening book choice even at low Elo", async () => {
		const fen = "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1";
		const engine = fakeEngine((req) => analysisOf(req, ["g6g5", "g6g4", "g6g7"], 3, [1500, 1400, 0]));
		const book: BookPolicy = {
			dispose: () => {},
			bookMove: async () =>
				({
					uci: "g6g5",
					from: "g6",
					to: "g5",
					san: "Qg5",
					source: "book",
					rankInLines: 0,
					cpLoss: 0,
					rationale: [],
				}) satisfies ChosenMove,
		};
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book });
		const out = await pipeline.run(input({ targetElo: 800, snapshot: snapshot({ fen }) }));
		expect(out?.rec.chosen.uci).toBe("g6g7");
		expect(out?.rec.chosen.source).toBe("mate");
	});
});
