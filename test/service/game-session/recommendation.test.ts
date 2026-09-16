// test/service/game-session/recommendation.test.ts — Task 30 Step 3: the §3.2 pipeline
// (book → analyse → select → plan) and the §7.5 search-budget policy.
import { describe, expect, it } from "bun:test";
import { applyMoves, legalMoves as legalMovesOf } from "@core/chess/san";
import { BOOK } from "@core/constants/books";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { LIMITS, SETTINGS_RANGES } from "@core/constants/limits";
import { MAIA, MAIA_INPUT } from "@core/constants/maia";
import { MAIA_SEARCH, SEARCH_BUDGET } from "@core/constants/search";
import { humanDepth } from "@core/engine/depth-policy";
import { requestEloForTarget } from "@core/engine/options";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { maiaSizeFor } from "@core/policy/maia-size";
import { policyQueryIdentity } from "@core/policy/policy-query";
import type { PolicyInferenceInputs, PolicyPort, PolicyResult } from "@core/policy/types";
import { createRng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import { effectiveElo } from "@core/strength/elo-map";
import { createSelectionState } from "@core/strength/move-selector";
import { rankedLines } from "@core/strength/quality";
import { maiaSelfElo, pressureTerms } from "@core/strength/selection-elo";
import { budgetController } from "@core/timing/budget";
import { ChessMimicHead, type ChessMimicInputs } from "@core/timing/chessmimic-head";
import { pieceCounts } from "@core/timing/features";
import { TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { timingSettingsFor } from "@service/game-session/presets";
import {
	clockBoundSearch,
	estimatedThinkMs,
	extraSearchMs,
	maiaContextPenalty,
	maiaExtraSearchmoves,
	maiaHistoryFens,
	maiaPlaysOpening,
	maiaSearchMode,
	maiaUnscoredMoves,
	mergeLines,
	ownMoveBudget,
	ownMoveFeatureDepth,
	ownMoveMaiaElo,
	type RecommendationInput,
	RecommendationPipeline,
	refereeElo,
	searchBudget,
	shapedRootSet,
	shapedSearchPlan,
} from "@service/game-session/recommendation";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, PositionSnapshot } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const NOW = 1_700_000_000_000;

/**
 * The model's knobs through the one conversion point. With no time control the per-class gain is
 * the blitz 1.0 and the default profile's preset knob is the identity, so this is numerically the
 * raw defaults these tests used before the 2026-09-15 base-speed rework.
 */
const MODEL_TIMING = timingSettingsFor(DEFAULT_SETTINGS.timing, undefined);

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
	const m = new TimingModel(new V1ParametricHead(), MODEL_TIMING, createRng("t"));
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

	it("depth follows active Elo across time controls, ignoring legacy manual ceilings", () => {
		for (const tc of ["bullet", "blitz", "rapid", "classical", "untimed"] as const) {
			const input = { ...comfortable(tc), targetElo: 1650 };
			// 17, not 16: the automatic depth curve ends at the Maia cutoff since 2026-09-15 (it ended
			// at the removed 3200 network switch), and the maximum applies from one above it.
			expect(searchBudget(input, settings({ depthCap: 6 })).depthCap).toBe(17);
			expect(searchBudget(input, settings({ depthCap: 30 })).depthCap).toBe(17);
			expect(searchBudget({ ...input, targetElo: 3001 }, settings({ depthCap: 6 })).depthCap).toBe(30);
		}
	});

	it("native engine mode retains its budget-dependent MultiPV floor", () => {
		const native = (multiPv: number): Settings => ({
			...settings({ multiPv }),
			strength: { ...DEFAULT_SETTINGS.strength, selectionMode: "engine-elo" },
		});
		const tiny = { ...comfortable("bullet"), plannedThinkMs: 400 }; // 240 ms → K = 3
		expect(searchBudget(tiny, native(1)).multiPv).toBe(3);
		expect(searchBudget(comfortable("blitz"), native(1)).multiPv).toBe(6);
		expect(searchBudget(comfortable("classical"), native(1)).multiPv).toBe(8);
		expect(searchBudget(tiny, native(4)).multiPv).toBe(4);
		expect(searchBudget(comfortable("classical"), native(8)).multiPv).toBe(8);
	});

	it("1650 sampling gets meaningful alternatives without increasing its search budget or panel line setting", () => {
		const s = settings({ multiPv: 4 });
		const budget = searchBudget({ ...comfortable("blitz"), targetElo: 1650 }, s);
		// depthCap 17 since the depth curve ends at the Maia cutoff (2026-09-15; it was 16).
		expect(budget).toEqual({ movetimeMs: 600, depthCap: 17, multiPv: 20 });
		expect(s.engine.multiPv).toBe(4);
		expect(searchBudget({ ...comfortable("blitz"), targetElo: 3800 }, s).multiPv).toBe(6);
		expect(searchBudget({ ...comfortable("blitz"), targetElo: 1650, legalMoves: 2 }, s).multiPv).toBe(
			2
		);
		expect(searchBudget({ ...comfortable("blitz"), targetElo: 1650, legalMoves: 1 }, s).multiPv).toBe(
			1
		);
	});

	// Updated 2026-09-15 (owner: "settings shouldnt really be modifying the model's ability to give
	// good moves"). This test used to pin `slow ≈ normal × 2` for `speedScale: 2` — the search
	// allocation moving with the user's speed slider, which is exactly what the rework removes.
	// The clock half of the old assertion is untouched and still pinned below.
	it("the estimate scales with the clock and with nothing the user sets for speed", () => {
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
		const lowClock = estimatedThinkMs({ ...base, myClockMs: 20_000 }, settings());
		expect(lowClock).toBeLessThan(normal);
		expect(normal).toBeGreaterThan(0);
		// The engine keeps the allocation the target rating implies at every base speed, across the
		// whole slider and at both ends of the clock.
		for (const baseSpeed of [
			SETTINGS_RANGES.baseSpeed.min,
			0.5,
			1,
			2,
			SETTINGS_RANGES.baseSpeed.max,
		]) {
			expect(estimatedThinkMs(base, settings({}, { baseSpeed }))).toBe(normal);
			expect(estimatedThinkMs({ ...base, myClockMs: 20_000 }, settings({}, { baseSpeed }))).toBe(
				lowClock
			);
		}
	});

	it("the search budget itself is unchanged across the base-speed slider", () => {
		// `searchBudget` is sized from `estimatedThinkMs`, so the decoupling has to be visible in
		// the movetime the engine is actually given — depth and breadth included.
		const position = {
			fen: START,
			ply: 20,
			myClockMs: 60_000,
			oppClockMs: 60_000,
			timeControl: { baseMs: 180_000, incMs: 0 },
			tau: 0.5,
			budgetUsedRatio: 0,
			targetElo: 1800,
		};
		const reference = ownMoveBudget(position, settings());
		for (const baseSpeed of [SETTINGS_RANGES.baseSpeed.min, 0.5, 2, SETTINGS_RANGES.baseSpeed.max])
			expect(ownMoveBudget(position, settings({}, { baseSpeed }))).toEqual(reference);
	});

	it("the search estimate uses the rating-aware clock allocation exactly once", () => {
		const base = {
			fen: START,
			ply: 40,
			myClockMs: 60_000,
			baseSec: 180,
			incSec: 0,
			tc: "blitz" as const,
			tau: 0.5,
			budgetUsedRatio: 0,
		};
		for (const targetElo of [500, 1200, 1800, 2400, 3000, 3800]) {
			let previous = Number.POSITIVE_INFINITY;
			for (const clockS of [60, 45, 30, 20, 5]) {
				const { pieces, pawns } = pieceCounts(START);
				const allocation = budgetController(
					{
						tc: base.tc,
						base_s: 180,
						base_eff: 180,
						inc_s: 0,
						clock_s: clockS,
						ply: base.ply,
						non_pawn_pieces: pieces,
						pawns,
						budget_used_ratio: 0,
						targetElo,
					},
					{ s_game: 0, iota: 0, pi_p: 0, tau: base.tau, rho_mirror: 0, motor_k: 1 }
				);
				const estimated = estimatedThinkMs(
					{ ...base, targetElo, myClockMs: clockS * 1000 },
					settings()
				);
				expect(estimated).toBeCloseTo(allocation * 1000, 6);
				expect(estimated).toBeLessThanOrEqual(previous);
				previous = estimated;
			}
		}
	});
});

describe("recommendation pipeline (§3.2)", () => {
	it("prepares native timing alongside search and uses that position's distribution", async () => {
		const requests: ChessMimicInputs[] = [];
		let finishInference: () => void = () => {
			throw new Error("inference not started");
		};
		const head = new ChessMimicHead({
			infer: async (request) => {
				requests.push(request);
				await new Promise<void>((resolve) => {
					finishInference = resolve;
				});
				return { band: request.band, probs: Array.from({ length: 30 }, (_, i) => Number(i === 6)) };
			},
			fallback: new V1ParametricHead(),
		});
		const timing = new TimingModel(head, MODEL_TIMING, createRng("native-timing"));
		timing.startGame({
			targetElo: 1650,
			profile: "balanced",
			baseSec: 180,
			incSec: 0,
			site: "chesscom",
			gameId: "g1",
		});
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 14));
		let finishSearch: () => void = () => {
			throw new Error("search not started");
		};
		const originalAnalyse = engine.analyse;
		engine.analyse = (request) => {
			const handle = originalAnalyse(request);
			return {
				...handle,
				result: handle.result.then(
					(result) =>
						new Promise<AnalysisResult>((resolve) => {
							finishSearch = () => resolve(result);
						})
				),
			};
		};
		const pipeline = new RecommendationPipeline({ engine, timing, book: null });
		const pending = pipeline.run(input({ targetElo: 1650 }));
		await Promise.resolve();
		await Promise.resolve();
		expect(engine.requests).toHaveLength(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			band: "1500_1600",
			rating: 1650,
			playerClockS: 180,
			opponentClockS: 180,
		});
		expect(timing.state.lastPlan).toBeNull();
		finishInference();
		await new Promise((resolve) => setTimeout(resolve, 0));
		finishSearch();
		const out = await pending;
		expect(out?.rec.plan.rationale.join(" ")).toContain("chessmimic band=1500_1600 bucket 6");
		expect(out?.rec.plan.rationale.join(" ")).not.toContain("fallback");
		expect(head.diagnostics(START)).toEqual({ head: "chessmimic", band: "1500_1600" });
	});
	it("a quick cached search gives warmed timing its short grace window", async () => {
		const head = new ChessMimicHead({
			infer: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				return { band: "1500_1600", probs: Array.from({ length: 30 }, (_, i) => Number(i === 5)) };
			},
			fallback: new V1ParametricHead(),
		});
		const timing = new TimingModel(head, MODEL_TIMING, createRng("cached-native"));
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 14));
		const pipeline = new RecommendationPipeline({ engine, timing, book: null });
		const out = await pipeline.run(input());
		expect(out?.rec.plan.rationale.join(" ")).toContain("chessmimic band=1500_1600 bucket 5");
	});
	it("a quick cached search cancels unfinished inference after its bounded grace", async () => {
		const head = new ChessMimicHead({
			infer: () => new Promise(() => {}),
			fallback: new V1ParametricHead(),
			budgetMs: 5,
		});
		const timing = new TimingModel(head, MODEL_TIMING, createRng("timing-timeout"));
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 14));
		const pipeline = new RecommendationPipeline({ engine, timing, book: null });
		const out = await pipeline.run(input());
		expect(out).not.toBeNull();
		expect(head.diagnostics(START)).toMatchObject({
			head: "v1-parametric",
			requestedHead: "chessmimic",
			fallbackReason: "search preparation ended before inference was ready",
		});
	});
	it("late-clock moves bypass timing inference and cancelled preparations never publish a plan", async () => {
		let calls = 0;
		const controller = new AbortController();
		const head = new ChessMimicHead({
			infer: async () => {
				calls++;
				controller.abort();
				return null;
			},
			fallback: new V1ParametricHead(),
		});
		const timing = new TimingModel(head, MODEL_TIMING, createRng("timing-urgent"));
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 14));
		const pipeline = new RecommendationPipeline({ engine, timing, book: null });
		const race = await pipeline.run(
			input({
				snapshot: snapshot({
					clocks: { w: { ms: 3000, running: true }, b: { ms: 90000, running: false } },
				}),
			})
		);
		expect(race?.rec.plan.features.clockRace).toBeGreaterThan(0);
		expect(calls).toBe(0);
		const previous = timing.state.lastPlan;
		expect(await pipeline.run(input({ signal: controller.signal }))).toBeNull();
		expect(calls).toBe(1);
		expect(timing.state.lastPlan).toBe(previous);
	});
	it("keeps partial search choices playable but outside comparable quality samples", async () => {
		const engine = fakeEngine((req) => {
			const result = analysisOf(req, ["e2e4", "d2d4"], 14);
			result.final.complete = false;
			return result;
		});
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(input());
		expect(out).not.toBeNull();
		expect(["e2e4", "d2d4"]).toContain(out!.rec.chosen.uci);
		expect(out!.rec.chosen.cpLoss).toBeUndefined();
		expect(out!.rec.chosen.quality).toEqual({
			kind: "search",
			eligible: false,
			reason: "incomplete",
			depth: 14,
			candidates: 2,
		});
	});
	it("preserves an unscored legal native choice from a partial final frame", async () => {
		const engine = fakeEngine((req) => {
			const result = analysisOf(req, ["e2e4", "d2d4"], 14);
			result.final.complete = false;
			result.bestmove = "a2a3";
			return result;
		});
		const s = settings();
		s.strength = { ...s.strength, selectionMode: "engine-elo", useOpeningBook: false };
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(input({ settings: s }));
		expect(out?.rec.chosen.uci).toBe("a2a3");
		expect(out?.rec.chosen.rankInLines).toBe(0);
		expect(out?.rec.chosen.cpLoss).toBeUndefined();
		expect(out?.rec.chosen.quality?.reason).toBe("incomplete");
	});
	it("sends the active persona target rather than the saved fixed engine strength", async () => {
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 14), 2800);
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const fixed = settings();
		fixed.strength = { ...fixed.strength, targetElo: 3800 };
		await pipeline.run(input({ settings: fixed, targetElo: 1650 }));
		expect(engine.requests[0]?.elo).toBe(1650);
		expect(engine.requests[0]?.multiPv).toBe(20);
		await pipeline.run(input({ settings: settings(), targetElo: 3800 }));
		expect(engine.requests[1]?.elo).toBeUndefined();
	});

	it("a short search preserves an evaluated lower-ranked native choice instead of forcing the top two", async () => {
		const engine = fakeEngine((req) => ({
			...analysisOf(req, ["e2e4", "d2d4", "a2a3"], 4, [30, 20, 0]),
			bestmove: "a2a3",
		}));
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const s = settings();
		s.strength = { ...s.strength, selectionMode: "engine-elo", useOpeningBook: false };
		const out = await pipeline.run(input({ settings: s }));
		expect(out?.rec.chosen.uci).toBe("a2a3");
		expect(out?.rec.chosen.rankInLines).toBe(3);
	});
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
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			now: () => 0,
		});
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
		expect(out?.fromBook).toBe(false);
		expect(out?.rec.plan.features.in_book).toBe(0);
	});

	it("does not retry when a low active Elo reaches its intentional depth ceiling", async () => {
		for (const targetElo of [400, 500]) {
			const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], req.limit.depth ?? 0));
			const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
			const out = await pipeline.run(input({ targetElo }));
			expect(engine.requests).toHaveLength(1);
			expect(out?.rec.depth).toBe(targetElo === 400 ? 6 : 7);
		}
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

	it("retains the full shallow candidate pool without presenting it as measured quality", async () => {
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4", "g1f3", "c2c4"], 4));
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const selected = new Set<string>();
		for (let seed = 0; seed < 24; seed++) {
			const out = await pipeline.run(input({ rng: createRng(`shallow-pool-${seed}`) }));
			expect(out?.rec.lines).toHaveLength(4);
			expect(out?.rec.chosen.quality?.eligible).toBe(false);
			expect(out?.rec.chosen.quality?.reason).toBe("shallow");
			selected.add(out?.rec.chosen.uci ?? "");
		}
		expect([...selected].some((move) => move === "g1f3" || move === "c2c4")).toBe(true);
	});

	it("nReasonable is the position's `n_reasonable` feature, not the MultiPV count", async () => {
		// Six lines, but only the top two are inside `TIMING_CONSTANTS.features.nReasonableCp`
		// (40 cp) of the best — `K` depends on the target and the time budget, so
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

/** A fake Maia port that answers with `answer` and records what it was asked and its signal. */
function fakePolicy(answer: (inputs: PolicyInferenceInputs) => Promise<PolicyResult | null>) {
	const calls: PolicyInferenceInputs[] = [];
	const signals: AbortSignal[] = [];
	const port: PolicyPort = {
		infer(inputs, preparation) {
			calls.push(inputs);
			if (preparation?.signal) signals.push(preparation.signal);
			return answer(inputs);
		},
		warm: () => {},
		dispose: () => {},
	};
	return { port, calls, signals };
}

const MAIA_START: PolicyResult = {
	moves: [
		["d2d4", 0.5],
		["e2e4", 0.3],
		["g1f3", 0.15],
		["c2c4", 0.05],
	],
	wdl: [0.3, 0.4, 0.3],
	size: "79m",
	ms: 42,
};

function strength(patch: Partial<Settings["strength"]>): Settings {
	const s = settings();
	s.strength = { ...s.strength, useOpeningBook: false, ...patch };
	return s;
}

function heldPolicy(result: PolicyResult, knownTopMoves?: string[]) {
	const inputs = {
		fen: START,
		historyFens: [START],
		size: result.size,
		selfElo: 1500,
		oppoElo: 1500,
	};
	return {
		fen: START,
		result,
		selfElo: 1500,
		historyPlies: 1,
		identity: policyQueryIdentity({
			inputs,
			selectionMode: strength({}).strength.selectionMode,
		}),
		...(knownTopMoves ? { knownTopMoves } : {}),
	};
}

describe("Maia-3 selection in the pipeline (2026-09-11)", () => {
	const FOUR = ["e2e4", "d2d4", "g1f3", "c2c4"];

	it("maiaSearchMode: through 3000 inclusive, with a port and no clock race", () => {
		const base = { targetElo: 1500, policy: true, clockRace: false };
		expect(maiaSearchMode(base)).toBe(true);
		expect(maiaSearchMode({ ...base, targetElo: MAIA.eloMax - 1 })).toBe(true);
		expect(maiaSearchMode({ ...base, targetElo: MAIA.eloMax })).toBe(true);
		expect(maiaSearchMode({ ...base, targetElo: MAIA.eloMax + 1 })).toBe(false);
		expect(maiaSearchMode({ ...base, policy: false })).toBe(false);
		expect(maiaSearchMode({ ...base, clockRace: true })).toBe(false);
	});

	it("refereeElo: full strength for Maia's referee search, native UCI_Elo otherwise", () => {
		expect(refereeElo(1500, true)).toBeUndefined();
		expect(refereeElo(1500, false)).toBe(1500);
		expect(refereeElo(3800, false)).toBeUndefined();
	});

	it("searchBudget asks for the sampling breadth in Maia mode whatever the selection mode", () => {
		const comfortable = {
			tc: "blitz" as const,
			myClockMs: 600_000,
			legalMoves: 20,
			plannedThinkMs: 7_500,
		};
		const native = strength({ selectionMode: "engine-elo" });
		expect(searchBudget({ ...comfortable, targetElo: 1500 }, native).multiPv).toBe(6);
		expect(searchBudget({ ...comfortable, targetElo: 1500, maia: true }, native).multiPv).toBe(20);
		expect(searchBudget({ ...comfortable, targetElo: 2100, maia: true }, native).multiPv).toBe(16);
		expect(searchBudget({ ...comfortable, targetElo: 2100, maia: true }, native).depthCap).toBe(
			searchBudget({ ...comfortable, targetElo: 2100 }, native).depthCap
		);
	});

	it("maiaHistoryFens: the last 8 positions oldest → newest ending with the board's own FEN", () => {
		expect(maiaHistoryFens(undefined, START)).toEqual([START]);
		const moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7"];
		const fen = applyMoves(START, moves)!;
		const fens = maiaHistoryFens({ fen: START, moves }, fen);
		expect(fens).toHaveLength(MAIA_INPUT.history);
		expect(fens[fens.length - 1]).toBe(fen);
		for (let i = 0; i < fens.length; i++)
			expect(fens[i]).toBe(i === fens.length - 1 ? fen : applyMoves(START, moves.slice(0, i + 3))!);
		const short = maiaHistoryFens(
			{ fen: START, moves: moves.slice(0, 3) },
			applyMoves(START, moves.slice(0, 3))!
		);
		expect(short).toHaveLength(4);
		expect(short[0]).toBe(applyMoves(START, [])!);
		// a history that does not reach the board is refused, not truncated
		expect(maiaHistoryFens({ fen: START, moves: moves.slice(0, 2) }, fen)).toEqual([fen]);
	});

	// Owner, 2026-09-15: one division at the Maia cutoff. This case pinned the prior's query at 3200;
	// the prior band is removed, so above the cutoff Maia is never asked.
	it("queries Maia through 3000 and nothing above it", async () => {
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port, calls } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		await pipeline.run(input({ targetElo: 1500, settings: strength({}) }));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.size).toBe(maiaSizeFor(1500));
		// The primary ceiling is inclusive and still uses an unrestricted referee.
		await pipeline.run(input({ targetElo: MAIA.eloMax, settings: strength({}) }));
		expect(calls).toHaveLength(2);
		expect(calls[1]?.size).toBe(maiaSizeFor(MAIA.eloMax));
		expect(engine.requests.at(-1)?.elo).toBeUndefined();
		for (const targetElo of [MAIA.eloMax + 1, 3200]) {
			await pipeline.run(input({ targetElo, settings: strength({}) }));
			expect(calls).toHaveLength(2);
			expect(engine.requests.at(-1)?.elo).toBe(requestEloForTarget(targetElo));
		}
		// the top setting is the pure-engine escape hatch
		await pipeline.run(input({ targetElo: LIMITS.eloMax, settings: strength({}) }));
		expect(calls).toHaveLength(2);
		expect(engine.requests.at(-1)?.elo).toBeUndefined();
	});

	it("the query carries the size for the target, the last 8 FENs, our effective E and the opponent's rating", async () => {
		const moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7"];
		const fen = applyMoves(START, moves)!;
		const engine = fakeEngine((req) => analysisOf(req, ["f1e1", "d2d3"], 14));
		const { port, calls } = fakePolicy(async () => null);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		await pipeline.run(
			input({
				targetElo: 1500,
				form: 0.5,
				settings: strength({}),
				snapshot: snapshot({ fen, ply: 10 }),
				moves,
				history: { fen: START, moves },
				opponentElo: 1380,
			})
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			size: maiaSizeFor(1500),
			fen,
			historyFens: maiaHistoryFens({ fen: START, moves }, fen),
			selfElo: effectiveElo(1500, 0.5),
			oppoElo: 1380,
		});
		expect(calls[0]?.selfElo).toBe(1575);
		expect(calls[0]?.historyFens).toHaveLength(8);
		// no opponent rating known → ours (`MAIA.oppoFallbackSelf`)
		await pipeline.run(input({ targetElo: 1500, form: 0.5, settings: strength({}) }));
		expect(calls[1]?.oppoElo).toBe(1575);
		expect(calls[1]?.historyFens).toEqual([START]);
	});

	it("the referee search runs at full strength with the sampling breadth, in every selection mode", async () => {
		for (const selectionMode of ["engine-elo", "persona-sampling", "hybrid"] as const) {
			const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
			const { port } = fakePolicy(async () => MAIA_START);
			const pipeline = new RecommendationPipeline({
				engine,
				timing: model(),
				book: null,
				policy: port,
			});
			const out = await pipeline.run(
				input({ targetElo: 1500, settings: strength({ selectionMode }) })
			);
			expect(engine.requests).toHaveLength(2);
			expect(engine.requests[0]?.searchmoves).toBeUndefined();
			expect(engine.requests[0]?.elo).toBeUndefined();
			// The unrestricted anchor supplies engine roots before the shaped comparison.
			expect(engine.requests[1]?.searchmoves).toEqual(shapedRootSet(MAIA_START, START));
			expect(engine.requests[1]?.multiPv).toBe(shapedRootSet(MAIA_START, START).length);
			expect(engine.requests[1]?.shaped).toBe(true);
			expect(out?.rec.chosen.source).toBe("maia");
			expect(FOUR).toContain(out?.rec.chosen.uci ?? "");
			// `p` is the model's probability of the drawn move, surfaced for the Engine view.
			const p = out?.rec.chosen.maiaProb ?? 0;
			expect(p).toBeGreaterThan(0);
			expect(out?.rec.maia).toMatchObject({ size: "79m", wdl: [0.3, 0.4, 0.3], ms: 42, p });
			// the query's rating and history ride along (H7.1 / §7 B2): a full clock, no pressure
			expect(out?.rec.maia?.selfElo).toBe(1500);
			expect(out?.rec.maia?.historyPlies).toBe(1);
		}
		// without a port nothing changes: native strength, native breadth
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const pipeline = new RecommendationPipeline({ engine, timing: model(), book: null });
		const out = await pipeline.run(
			input({ targetElo: 1500, settings: strength({ selectionMode: "engine-elo" }) })
		);
		expect(engine.requests[0]?.elo).toBe(1500);
		expect(engine.requests[0]?.multiPv).toBe(6);
		expect(out?.rec.chosen.source).toBe("engine-elo");
		expect(out?.rec.maia).toBeUndefined();
	});

	it("a `null` answer leaves the move to the engine's own policy", async () => {
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port, calls } = fakePolicy(async () => null);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		const out = await pipeline.run(input({ targetElo: 1500, settings: strength({}) }));
		expect(calls).toHaveLength(1);
		expect(out).not.toBeNull();
		expect(out?.rec.chosen.source).not.toBe("maia");
		expect(out?.rec.chosen.rationale.join(" ")).not.toContain("maia");
		expect(out?.rec.maia).toBeUndefined();
	});

	it("a rejected query is caught, not thrown", async () => {
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port } = fakePolicy(async () => {
			throw new Error("port closed");
		});
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		const out = await pipeline.run(input({ targetElo: 1500, settings: strength({}) }));
		expect(out?.rec.chosen.source).not.toBe("maia");
		expect(out?.rec.maia).toBeUndefined();
	});

	it("a port that never answers uses the shared preparation deadline and is aborted", async () => {
		let elapsed = NOW;
		const engine = fakeEngine((req) => {
			elapsed += req.limit.movetimeMs ?? 0;
			return analysisOf(req, FOUR, 14);
		});
		const { port, calls, signals } = fakePolicy(() => {
			elapsed += MAIA_SEARCH.shaped.policyFirstMs + 1;
			return new Promise(() => {});
		});
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
			now: () => elapsed,
		});
		const started = performance.now();
		const out = await pipeline.run(input({ targetElo: 1500, settings: strength({}) }));
		expect(performance.now() - started).toBeLessThan(MAIA.inferenceBudgetMs);
		expect(calls).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(true);
		expect(out).not.toBeNull();
		expect(out?.rec.chosen.source).not.toBe("maia");
		expect(out?.rec.maia).toBeUndefined();
		expect(elapsed - NOW).toBe(SEARCH_BUDGET.moveMs.blitz);
		expect(engine.requests.reduce((sum, req) => sum + (req.limit.movetimeMs ?? 0), 0)).toBe(
			SEARCH_BUDGET.moveMs.blitz - MAIA_SEARCH.shaped.policyFirstMs - 1
		);
	});

	it("an answer that arrives inside the budget after the search is used", async () => {
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port } = fakePolicy(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return MAIA_START;
		});
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		const out = await pipeline.run(input({ targetElo: 1500, settings: strength({}) }));
		expect(out?.rec.chosen.source).toBe("maia");
	});

	it("a clock race is not Maia's: no query, native strength", async () => {
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port, calls } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		const out = await pipeline.run(
			input({
				targetElo: 1500,
				settings: strength({}),
				snapshot: snapshot({
					clocks: { w: { ms: 3000, running: true }, b: { ms: 90000, running: false } },
				}),
			})
		);
		expect(out?.rec.plan.features.clockRace).toBeGreaterThan(0);
		expect(calls).toHaveLength(0);
		expect(engine.requests[0]?.elo).toBe(1500);
		expect(out?.rec.chosen.source).not.toBe("maia");
	});

	it("the book still answers first; the mate guard still wins", async () => {
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
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: { bookMove: async () => book, dispose: () => {} },
			policy: port,
		});
		// 1800: above `BOOK.maiaOnlyElo`, so the book still answers first (H14.2 is tested below)
		const out = await pipeline.run(input({ targetElo: 1800 }));
		expect(out?.rec.chosen.source).toBe("book");
		expect(out?.rec.maia).toMatchObject({ size: "79m", wdl: [0.3, 0.4, 0.3], ms: 42 });
		expect(out?.rec.maia?.p).toBeUndefined();
		const fen = "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1";
		const mate = fakeEngine((req) => analysisOf(req, ["g6g5", "g6g4", "g6g7"], 14, [1500, 1400, 0]));
		const mating = fakePolicy(async () => ({
			...MAIA_START,
			moves: [
				["g6g5", 0.9],
				["g6g7", 0.1],
			],
		}));
		const guarded = new RecommendationPipeline({
			engine: mate,
			timing: model(),
			book: null,
			policy: mating.port,
		});
		const won = await guarded.run(
			input({ targetElo: 1500, settings: strength({}), snapshot: snapshot({ fen }) })
		);
		expect(won?.rec.chosen.uci).toBe("g6g7");
		expect(won?.rec.chosen.source).toBe("mate");
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

/** Maia's favourite (b1c3) and two long shots are outside the engine's four; 0.55 unscored. */
const MAIA_OUTSIDE: PolicyResult = {
	...MAIA_START,
	moves: [
		["b1c3", 0.5],
		["e2e4", 0.25],
		["d2d4", 0.15],
		["g1f3", 0.05],
		["a2a3", 0.03],
		["h2h3", 0.02],
	],
};

/** Delays policy until the broad main search starts, after any unrestricted anchor. */
function fallbackPipeline(
	engine: ReturnType<typeof fakeEngine>,
	port: PolicyPort,
	now?: () => number
): RecommendationPipeline {
	const waiting: Array<() => void> = [];
	let elapsed = NOW;
	const analyse = engine.analyse.bind(engine);
	engine.analyse = (req) => {
		const handle = analyse(req);
		if (req.multiPv > SEARCH_BUDGET.ponderMultiPv) {
			for (const wake of waiting.splice(0)) wake();
		}
		return handle;
	};
	const late: PolicyPort = {
		...port,
		infer: (inputs, preparation) =>
			new Promise((resolve) => {
				if (!now) elapsed += MAIA_SEARCH.shaped.policyFirstMs + 1;
				waiting.push(() => resolve(port.infer(inputs, preparation)));
			}),
	};
	return new RecommendationPipeline({
		engine,
		timing: model(),
		book: null,
		policy: late,
		now: now ?? (() => elapsed),
	});
}

// H10 (2026-09-13): everything in this block is the fallback path (`fallbackPipeline`).
describe("Maia's unscored favourites — the extra referee search (2026-09-12; the H10 fallback)", () => {
	const FOUR = ["e2e4", "d2d4", "g1f3", "c2c4"];
	/** The main search answers the four; a `searchmoves` request answers exactly what it asked for. */
	const refereeAndExtra = (req: AnalysisRequest): AnalysisResult =>
		req.searchmoves ? analysisOf(req, req.searchmoves, 12) : analysisOf(req, FOUR, 14);
	const pipelineWith = fallbackPipeline;

	it("maiaUnscoredMoves: legal, unscored, at p ≥ minProb, most likely first, duplicates folded", () => {
		const scored = lines(FOUR, 14);
		const policy: PolicyResult = {
			...MAIA_START,
			moves: [
				["a2a3", 0.03],
				["b1c3", 0.4],
				["e2e4", 0.3],
				["b1c3", 0.1],
				["h2h3", 0.004],
				["e2e5", 0.2],
			],
		};
		expect(maiaUnscoredMoves(policy, scored, START)).toEqual([
			["b1c3", 0.4],
			["a2a3", 0.03],
		]);
		expect(maiaUnscoredMoves(MAIA_START, scored, START)).toEqual([]);
	});

	it("maiaExtraSearchmoves: the mass rule, the top-move rule, and the candidate cap", () => {
		expect(maiaExtraSearchmoves([])).toEqual([]);
		// under both thresholds: nothing
		expect(
			maiaExtraSearchmoves([
				["b1c3", MAIA.extraMassMin / 2],
				["a2a3", MAIA.extraMassMin / 4],
			])
		).toEqual([]);
		// the mass rule, spread over small moves none of which passes the top rule
		const spread: Array<[string, number]> = [
			["b1c3", 0.02],
			["a2a3", 0.02],
			["h2h3", 0.02],
		];
		expect(spread.reduce((s, [, p]) => s + p, 0)).toBeGreaterThanOrEqual(MAIA.extraMassMin);
		expect(maiaExtraSearchmoves(spread)).toEqual(["b1c3", "a2a3", "h2h3"]);
		// the top-move rule on its own
		expect(maiaExtraSearchmoves([["b1c3", MAIA.extraTopProb]])).toEqual(["b1c3"]);
		// the cap: the first `extraCandidates` of an already-ordered list
		const many: Array<[string, number]> = [
			"b1c3",
			"a2a3",
			"h2h3",
			"a2a4",
			"h2h4",
			"b2b3",
			"g2g3",
			"f2f3",
		].map((uci, i) => [uci, 0.1 - i * 0.01]);
		expect(maiaExtraSearchmoves(many)).toEqual(many.slice(0, MAIA.extraCandidates).map(([u]) => u));
		expect(MAIA.extraCandidates).toBe(6);
	});

	it("extraSearchMs: its own cap, never over the main movetime, floored at minMovetimeMs", () => {
		// §7 A4 (2026-09-13): its own budget, a function of the move's budget alone — the elapsed-time
		// parameter it once took was never read and is gone.
		const budget = { movetimeMs: 600, depthCap: 20, multiPv: 20 };
		expect(extraSearchMs(budget)).toBe(MAIA.extraSearchMs);
		expect(extraSearchMs({ ...budget, movetimeMs: 200 })).toBe(200);
		expect(extraSearchMs({ ...budget, movetimeMs: 100 })).toBe(SEARCH_BUDGET.minMovetimeMs);
		expect(extraSearchMs.length).toBe(1);
	});

	it("clockBoundSearch: true exactly when the clock fraction is at or under the movetime", () => {
		const budget = { movetimeMs: 600, depthCap: 20, multiPv: 20 };
		expect(clockBoundSearch(180_000, budget)).toBe(false);
		expect(clockBoundSearch(12_000, budget)).toBe(true);
		expect(clockBoundSearch(8_000, budget)).toBe(true);
		// an untimed game has no clock to protect
		expect(clockBoundSearch(0, budget)).toBe(false);
	});

	it("mergeLines: one line per root, the main frame first, the extra frame appended, multipv renumbered", () => {
		// §7 A1 (2026-09-13): never interleaved — `lines[0]` is the reference for the panel, the
		// timing features and, through `rankedLines`, every candidate's loss.
		const main = lines(FOUR, 14, [30, 20, 10, 0]);
		const extra = lines(["e2e4", "b1c3", "a2a3"], 12, [99, 20, -5]);
		const merged = mergeLines(main, extra);
		expect(merged.map((l) => l.pvUci[0])).toEqual(["e2e4", "d2d4", "g1f3", "c2c4", "b1c3", "a2a3"]);
		expect(merged.map((l) => l.multipv)).toEqual([1, 2, 3, 4, 5, 6]);
		// the main e2e4 (cp 30, depth 14) is kept; the extra's duplicate is dropped
		expect(merged[0]?.score.cp).toBe(30);
		expect(merged[0]?.depth).toBe(14);
		expect(merged[4]?.depth).toBe(12);
		expect(merged[4]?.score.cp).toBe(20);
		expect(mergeLines(main, [])).toEqual(main);
		expect(mergeLines(main, lines(["e2e4"], 12))).toEqual(main);
		// an extra line scoring above the main best still sits behind the whole main frame
		expect(mergeLines(main, lines(["b1c3"], 12, [999]))[0]?.pvUci[0]).toBe("e2e4");
	});

	it("(a) a favourite outside the scored set gets a searchmoves search and can be the move", async () => {
		const picks: string[] = [];
		let extraRequest: AnalysisRequest | undefined;
		let withExtra: ChosenMove | undefined;
		for (let seed = 0; seed < 12; seed++) {
			const engine = fakeEngine(refereeAndExtra);
			const { port } = fakePolicy(async () => MAIA_OUTSIDE);
			const out = await pipelineWith(engine, port).run(
				input({ targetElo: 1500, settings: strength({}), rng: createRng(`extra-${seed}`) })
			);
			expect(engine.requests).toHaveLength(3);
			const [, main, extra] = engine.requests;
			extraRequest = extra;
			expect(extra?.searchmoves).toEqual(["b1c3", "a2a3", "h2h3"]);
			expect(extra?.multiPv).toBe(3);
			expect(extra?.elo).toBeUndefined();
			expect(extra?.priority).toBe("move");
			expect(extra?.fen).toBe(main?.fen ?? "");
			expect(extra?.moves).toEqual(main?.moves);
			expect(extra?.limit.depth).toBe(main?.limit.depth);
			expect(extra?.limit.movetimeMs).toBeGreaterThanOrEqual(SEARCH_BUDGET.minMovetimeMs);
			expect(extra?.limit.movetimeMs).toBeLessThanOrEqual(MAIA.extraSearchMs);
			expect(out?.rec.chosen.source).toBe("maia");
			expect(out?.rec.chosen.rationale.join(" ")).toContain("scored mass 1 (+3 from searchmoves)");
			// the merged pool is what the recommendation carries: seven scored roots, one frame
			expect(out?.rec.lines.map((l) => l.pvUci[0]).sort()).toEqual(
				[...FOUR, "b1c3", "a2a3", "h2h3"].sort()
			);
			expect(out?.rec.lines.map((l) => l.multipv)).toEqual([1, 2, 3, 4, 5, 6, 7]);
			picks.push(out?.rec.chosen.uci ?? "");
			if (out?.rec.chosen.uci === "b1c3") withExtra = out.rec.chosen;
		}
		expect(extraRequest).toBeDefined();
		// half of Maia's mass is on b1c3: twelve seeds cannot all miss it
		expect(picks).toContain("b1c3");
		expect(withExtra?.source).toBe("maia");
		expect(withExtra?.maiaProb).toBe(0.5);
		expect(withExtra?.rankInLines).toBeGreaterThan(1);
		// §7 A2: two plies shallower is inside `qualityDepthTolerance` — a comparable sample, measured
		// against the main frame's best (cp 30 vs the extra line's cp 30 → 0)
		expect(withExtra?.quality?.eligible).toBe(true);
		expect(withExtra?.quality?.reason).toBeUndefined();
		expect(withExtra?.cpLoss).toBe(0);
	});

	it("(a) the extra search asks for at most extraCandidates, Maia's most likely first", async () => {
		const engine = fakeEngine(refereeAndExtra);
		const { port } = fakePolicy(async () => ({
			...MAIA_START,
			moves: [
				["e2e4", 0.3],
				["a2a3", 0.05],
				["b1c3", 0.2],
				["h2h3", 0.04],
				["a2a4", 0.06],
				["h2h4", 0.03],
				["b2b3", 0.07],
				["g2g3", 0.02],
				["f2f3", 0.004],
				["d2d4", 0.2],
			],
		}));
		await pipelineWith(engine, port).run(input({ targetElo: 1500, settings: strength({}) }));
		expect(engine.requests[2]?.searchmoves).toEqual(["b1c3", "b2b3", "a2a4", "a2a3", "h2h3", "h2h4"]);
		expect(engine.requests[2]?.multiPv).toBe(MAIA.extraCandidates);
	});

	it("(b) below extraMassMin with no strong single move there is no extra request", async () => {
		const engine = fakeEngine(refereeAndExtra);
		const { port } = fakePolicy(async () => ({
			...MAIA_START,
			moves: [
				["e2e4", 0.5],
				["d2d4", 0.3],
				["g1f3", 0.15],
				["b1c3", 0.03],
				["a2a3", 0.02],
			],
		}));
		const out = await pipelineWith(engine, port).run(
			input({ targetElo: 1500, settings: strength({}) })
		);
		expect(engine.requests).toHaveLength(2);
		expect(out?.rec.chosen.source).toBe("maia");
		expect(out?.rec.chosen.rationale.join(" ")).not.toContain("searchmoves");
		expect(FOUR).toContain(out?.rec.chosen.uci ?? "");
	});

	it("(c) a clock race never spends the extra search", async () => {
		const engine = fakeEngine(refereeAndExtra);
		const { port, calls } = fakePolicy(async () => MAIA_OUTSIDE);
		const out = await pipelineWith(engine, port).run(
			input({
				targetElo: 1500,
				settings: strength({}),
				snapshot: snapshot({
					clocks: { w: { ms: 3000, running: true }, b: { ms: 90000, running: false } },
				}),
			})
		);
		expect(out?.rec.plan.features.clockRace).toBeGreaterThan(0);
		expect(calls).toHaveLength(0);
		expect(engine.requests).toHaveLength(1);
		expect(engine.requests[0]?.searchmoves).toBeUndefined();
	});

	it("(c) a main search the clock fraction cut short is not followed by an extra one", async () => {
		// 8 s on a 3+2 clock: no race (own threshold 5 s), but 0.05 · 8 000 = 400 ms < the blitz base.
		const engine = fakeEngine(refereeAndExtra);
		const { port, calls } = fakePolicy(async () => MAIA_OUTSIDE);
		const out = await pipelineWith(engine, port).run(
			input({
				targetElo: 1500,
				settings: strength({}),
				snapshot: snapshot({
					clocks: { w: { ms: 8000, running: true }, b: { ms: 180_000, running: false } },
				}),
			})
		);
		expect(out?.rec.plan.features.clockRace ?? 0).toBe(0);
		expect(calls).toHaveLength(1);
		expect(engine.requests).toHaveLength(1);
		expect(engine.requests[0]?.limit.movetimeMs).toBe(400 - MAIA_SEARCH.shaped.policyFirstMs - 1);
		expect(out?.rec.chosen.source).toBe("maia");
		expect(FOUR).toContain(out?.rec.chosen.uci ?? "");
	});

	it("(d) a failed extra search leaves the main-set draw exactly as before", async () => {
		const engine = fakeEngine((req) => (req.searchmoves ? null : analysisOf(req, FOUR, 14)));
		const { port } = fakePolicy(async () => MAIA_OUTSIDE);
		const out = await pipelineWith(engine, port).run(
			input({ targetElo: 1500, settings: strength({}), rng: createRng("failed-extra") })
		);
		expect(engine.requests).toHaveLength(3);
		expect(engine.requests[2]?.searchmoves).toEqual(["b1c3", "a2a3", "h2h3"]);
		expect(out?.rec.chosen.source).toBe("maia");
		expect(FOUR).toContain(out?.rec.chosen.uci ?? "");
		expect(out?.rec.lines).toHaveLength(4);
		const text = out?.rec.chosen.rationale.join(" ") ?? "";
		expect(text).toContain("scored mass 0.45 ");
		expect(text).not.toContain("searchmoves");
		// the same draw the main set alone produces
		const plain = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const alone = await pipelineWith(plain, fakePolicy(async () => MAIA_OUTSIDE).port).run(
			input({ targetElo: 1500, settings: strength({}), rng: createRng("failed-extra") })
		);
		expect(plain.requests).toHaveLength(3);
		expect(alone?.rec.chosen.uci).toBe(out?.rec.chosen.uci ?? "");
	});

	it("(e) a signal aborted once the policy has answered issues no extra request", async () => {
		const controller = new AbortController();
		const engine = fakeEngine(refereeAndExtra);
		const { port } = fakePolicy(async () => {
			controller.abort();
			return MAIA_OUTSIDE;
		});
		const out = await pipelineWith(engine, port).run(
			input({ targetElo: 1500, settings: strength({}), signal: controller.signal })
		);
		expect(out).toBeNull();
		expect(engine.requests).toHaveLength(2);
		expect(engine.requests[0]?.searchmoves).toBeUndefined();
	});

	it("without a policy answer or above 3000, no extra candidate search runs", async () => {
		const engine = fakeEngine(refereeAndExtra);
		const { port } = fakePolicy(async () => null);
		await pipelineWith(engine, port).run(input({ targetElo: 1500, settings: strength({}) }));
		expect(engine.requests).toHaveLength(2);
		const high = fakeEngine(refereeAndExtra);
		await pipelineWith(high, fakePolicy(async () => MAIA_OUTSIDE).port).run(
			input({ targetElo: MAIA.eloMax + 1, settings: strength({}) })
		);
		expect(high.requests).toHaveLength(1);
		expect(high.requests[0]?.elo).toBe(MAIA.eloMax + 1);
	});

	// §7 A1 (2026-09-13): a 260 ms search that has not seen the refutation must not become the
	// reference for the panel's eval, the timing features or every other candidate's loss.
	it("(A1) an optimistic shallow extra line never changes rec.eval nor the loss reference", async () => {
		const optimistic = (req: AnalysisRequest): AnalysisResult =>
			req.searchmoves
				? analysisOf(req, req.searchmoves, 12, [99, 40, -5])
				: analysisOf(req, FOUR, 14, [30, 20, 10, 0]);
		let extraPick: ChosenMove | undefined;
		let mainPick: ChosenMove | undefined;
		for (let seed = 0; seed < 16; seed++) {
			const engine = fakeEngine(optimistic);
			const out = await pipelineWith(engine, fakePolicy(async () => MAIA_OUTSIDE).port).run(
				input({ targetElo: 1500, settings: strength({}), rng: createRng(`a1-${seed}`) })
			);
			expect(engine.requests).toHaveLength(3);
			// the recommendation's eval, first line and the whole leading frame are the main search's
			expect(out?.rec.eval).toEqual({ cp: 30 });
			expect(out?.rec.lines[0]?.pvUci[0]).toBe("e2e4");
			expect(out?.rec.lines.slice(0, 4).map((l) => l.pvUci[0])).toEqual(FOUR);
			expect(out?.rec.lines.slice(0, 4).every((l) => l.depth === 14)).toBe(true);
			expect(out?.rec.lines[4]).toMatchObject({ pvUci: ["b1c3"], depth: 12, score: { cp: 99 } });
			// the reference the selector and the quality accounting rank against is the main best
			expect(rankedLines(out?.rec.lines ?? [])[0]?.pvUci[0]).toBe("e2e4");
			if (out?.rec.chosen.uci === "b1c3") extraPick = out.rec.chosen;
			else if (out?.rec.chosen.uci === "d2d4") mainPick = out.rec.chosen;
		}
		// the drawn extra line is a candidate with its own score; its loss is against the main best
		expect(extraPick?.source).toBe("maia");
		expect(extraPick?.cpLoss).toBe(0);
		expect(extraPick?.rankInLines).toBe(2);
		// a main-frame pick loses 10 cp against the main best, not 79 against the optimistic line
		expect(mainPick?.cpLoss).toBe(10);
		expect(mainPick?.quality?.eligible).toBe(true);
	});

	it("(A3) an incomplete extra frame is ignored and the main-set draw stands", async () => {
		const partial = (req: AnalysisRequest): AnalysisResult => {
			if (!req.searchmoves) return analysisOf(req, FOUR, 14);
			const r = analysisOf(req, req.searchmoves.slice(0, 1), 12, [99]);
			r.final.complete = false;
			return r;
		};
		const engine = fakeEngine(partial);
		const out = await pipelineWith(engine, fakePolicy(async () => MAIA_OUTSIDE).port).run(
			input({ targetElo: 1500, settings: strength({}), rng: createRng("a3") })
		);
		expect(engine.requests).toHaveLength(3);
		expect(out?.rec.lines).toHaveLength(4);
		expect(out?.rec.eval).toEqual({ cp: 30 });
		expect(FOUR).toContain(out?.rec.chosen.uci ?? "");
		expect(out?.rec.chosen.rationale.join(" ")).not.toContain("searchmoves");
		const plain = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const alone = await pipelineWith(plain, fakePolicy(async () => MAIA_OUTSIDE).port).run(
			input({ targetElo: 1500, settings: strength({}), rng: createRng("a3") })
		);
		expect(alone?.rec.chosen.uci).toBe(out?.rec.chosen.uci ?? "");
	});
});

describe("one rating for the query, the rails and the human frame (2026-09-13, §7 B2 / H2 / H5)", () => {
	const FOUR = ["e2e4", "d2d4", "g1f3", "c2c4"];
	/** Opponent at 12 s of a 3+0 clock: ordinary pressure (≥ 0.35), not a race (≥ 10 s). */
	const pressured = () =>
		snapshot({
			clocks: { w: { ms: 180_000, running: true }, b: { ms: 12_000, running: false } },
			timeControl: { baseMs: 180_000, incMs: 0 },
		});
	const position = (snap: PositionSnapshot, targetElo = 1500, form = 0) => ({
		fen: snap.fen,
		ply: snap.ply,
		myClockMs: snap.clocks.w.ms,
		oppClockMs: snap.clocks.b.ms,
		timeControl: snap.timeControl,
		tau: 0.5,
		budgetUsedRatio: 0,
		targetElo,
		form,
		maia: true,
	});

	it("maiaContextPenalty: clock and think terms, their interaction, the cap, and 0 when untimed", () => {
		const K = MAIA.context;
		const easy = maiaContextPenalty({
			myClockMs: 180_000,
			baseMs: 180_000,
			plannedThinkMs: 10_000,
			tc: "blitz",
		});
		expect(easy).toEqual({ clockPressure: 0, shortThink: 0, penalty: 0 });
		const clockOnly = maiaContextPenalty({
			myClockMs: 90_000,
			baseMs: 180_000,
			plannedThinkMs: 10_000,
			tc: "blitz",
		});
		expect(clockOnly.clockPressure).toBeCloseTo(0.5, 9);
		expect(clockOnly.penalty).toBeCloseTo(K.clockElo * 0.5, 9);
		const thinkOnly = maiaContextPenalty({
			myClockMs: 180_000,
			baseMs: 180_000,
			plannedThinkMs: 2_500,
			tc: "blitz",
		});
		expect(thinkOnly.shortThink).toBeCloseTo(0.5, 9);
		expect(thinkOnly.penalty).toBeCloseTo(K.thinkElo * 0.5, 9);
		const both = maiaContextPenalty({
			myClockMs: 90_000,
			baseMs: 180_000,
			plannedThinkMs: 2_500,
			tc: "blitz",
		});
		expect(both.penalty).toBeCloseTo(
			K.clockElo * 0.5 + K.thinkElo * 0.5 + K.interactionElo * 0.25,
			9
		);
		const worst = maiaContextPenalty({
			myClockMs: 0,
			baseMs: 180_000,
			plannedThinkMs: 0,
			tc: "bullet",
		});
		expect(worst.penalty).toBe(Math.min(K.maxPenalty, K.clockElo + K.thinkElo + K.interactionElo));
		// no base clock (untimed, or the control has not arrived): neither term applies
		expect(
			maiaContextPenalty({ myClockMs: 0, baseMs: 0, plannedThinkMs: 0, tc: "untimed" }).penalty
		).toBe(0);
		expect(
			maiaContextPenalty({ myClockMs: 5_000, baseMs: 0, plannedThinkMs: 100, tc: "blitz" })
				.clockPressure
		).toBe(0);
		// more clock than the base (increments) is not negative pressure
		expect(
			maiaContextPenalty({ myClockMs: 200_000, baseMs: 180_000, plannedThinkMs: 10_000, tc: "blitz" })
				.penalty
		).toBe(0);
	});

	it("under opponent pressure the query's selfElo is exactly maiaSelfElo of the same terms", async () => {
		const snap = pressured();
		const terms = pressureTerms({
			fen: START,
			myClockMs: 180_000,
			oppClockMs: 12_000,
			baseMs: 180_000,
			incrementMs: 0,
		});
		expect(terms.pressureReduction).toBeGreaterThan(0);
		expect(terms.race).toBeNull();
		const context = ownMoveMaiaElo(position(snap), strength({}));
		expect(context.pressure.pressureReduction).toBe(terms.pressureReduction);
		// a full own clock: no clock term; the fresh 3+0 allocation (≈ 4.8 s) sits just under the
		// blitz think reference, so the think term is a few Elo — the pressure term dominates
		expect(context.context.clockPressure).toBe(0);
		expect(context.contextEloPenalty).toBeLessThan(10);
		const expected = maiaSelfElo({
			targetElo: 1500,
			form: 0,
			blunderScale: 1,
			pressureReduction: terms.pressureReduction,
			contextEloPenalty: context.contextEloPenalty,
		});
		expect(expected).toBeLessThan(1500 - terms.pressureReduction + 1);
		expect(context.selfElo).toBe(expected);
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port, calls } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		const out = await pipeline.run(
			input({ targetElo: 1500, settings: strength({}), snapshot: snap })
		);
		expect(calls[0]?.selfElo).toBe(expected);
		expect(calls[0]?.oppoElo).toBe(expected);
		expect(out?.rec.maia?.selfElo).toBe(expected);
		expect(out?.rec.chosen.source).toBe("maia");
	});

	it("the mistakes slider is an Elo offset on the query: 0 → +eloSpan, 2 → −eloSpan (H2)", async () => {
		for (const [blunderScale, offset] of [
			[0, MAIA.slider.eloSpan],
			[1, 0],
			[2, -MAIA.slider.eloSpan],
		] as const) {
			const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
			const { port, calls } = fakePolicy(async () => MAIA_START);
			const pipeline = new RecommendationPipeline({
				engine,
				timing: model(),
				book: null,
				policy: port,
			});
			const out = await pipeline.run(input({ targetElo: 1500, settings: strength({ blunderScale }) }));
			expect(calls[0]?.selfElo).toBe(1500 + offset);
			expect(out?.rec.maia?.selfElo).toBe(1500 + offset);
		}
	});

	it("a low own clock lowers selfElo through the context penalty, never below the floor", async () => {
		// 30 s of a 3+0 clock: clock pressure 5/6, and a squeezed think; no own race (≥ 5 s)
		const snap = snapshot({
			clocks: { w: { ms: 30_000, running: true }, b: { ms: 180_000, running: false } },
			timeControl: { baseMs: 180_000, incMs: 0 },
		});
		const context = ownMoveMaiaElo(position(snap), strength({}));
		expect(context.context.clockPressure).toBeCloseTo(1 - 30_000 / 180_000, 9);
		expect(context.contextEloPenalty).toBeGreaterThan(0);
		expect(context.contextEloPenalty).toBeLessThanOrEqual(MAIA.context.maxPenalty);
		expect(context.selfElo).toBe(
			maiaSelfElo({
				targetElo: 1500,
				form: 0,
				blunderScale: 1,
				pressureReduction: 0,
				contextEloPenalty: context.contextEloPenalty,
			})
		);
		expect(context.selfElo).toBeLessThan(1500);
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port, calls } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		await pipeline.run(input({ targetElo: 1500, settings: strength({}), snapshot: snap }));
		expect(calls[0]?.selfElo).toBe(context.selfElo);
		// the floor: a 500 target under the worst context still asks at `MAIA.context.eloFloor`
		const floored = ownMoveMaiaElo(
			position(
				snapshot({
					clocks: { w: { ms: 5_500, running: true }, b: { ms: 180_000, running: false } },
					timeControl: { baseMs: 180_000, incMs: 0 },
				}),
				500
			),
			strength({ blunderScale: 2 })
		);
		expect(floored.selfElo).toBe(MAIA.context.eloFloor);
	});

	it("reports the history the query carried (H7.1 / §7 D3)", async () => {
		const moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7"];
		const fen = applyMoves(START, moves)!;
		const engine = fakeEngine((req) => analysisOf(req, ["f1e1", "d2d3"], 14));
		const { port } = fakePolicy(async () => ({
			...MAIA_START,
			moves: [
				["f1e1", 0.6],
				["d2d3", 0.4],
			],
		}));
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		const full = await pipeline.run(
			input({
				targetElo: 1500,
				settings: strength({}),
				snapshot: snapshot({ fen, ply: 10 }),
				moves,
				history: { fen: START, moves },
			})
		);
		expect(full?.rec.maia?.historyPlies).toBe(MAIA_INPUT.history);
		// no history that reaches the board: the degenerate single frame, reported as such
		const bare = await pipeline.run(
			input({ targetElo: 1500, settings: strength({}), snapshot: snapshot({ fen, ply: 10 }), moves })
		);
		expect(bare?.rec.maia?.historyPlies).toBe(1);
	});

	it("H7.3: a held policy answer for exactly this board is used without a query; another board is ignored", async () => {
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port, calls } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		const held = heldPolicy(MAIA_START);
		const out = await pipeline.run(
			input({ targetElo: 1500, settings: strength({}), policyAnswer: held })
		);
		expect(calls).toHaveLength(0);
		expect(out?.rec.chosen.source).toBe("maia");
		expect(out?.rec.maia).toMatchObject({ size: "79m", selfElo: 1500, historyPlies: 1 });
		const other = { ...held, fen: applyMoves(START, ["e2e4"])! };
		const fresh = await pipeline.run(
			input({ targetElo: 1500, settings: strength({}), policyAnswer: other })
		);
		expect(calls).toHaveLength(1);
		expect(fresh?.rec.maia?.selfElo).toBe(1500);
		// a held answer is not used outside Maia mode (a clock race, or no port)
		const race = await pipeline.run(
			input({
				targetElo: 1500,
				settings: strength({}),
				policyAnswer: held,
				snapshot: snapshot({
					clocks: { w: { ms: 3000, running: true }, b: { ms: 90000, running: false } },
				}),
			})
		);
		expect(race?.rec.maia).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("H6.3: the session's committed size is the size queried; otherwise the size for the target", async () => {
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port, calls } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		await pipeline.run(input({ targetElo: 1500, settings: strength({}), maiaSize: "79m" }));
		expect(calls[0]?.size).toBe("79m");
		await pipeline.run(input({ targetElo: 1500, settings: strength({}) }));
		expect(calls[1]?.size).toBe(maiaSizeFor(1500));
	});
});

describe("the human-depth frame (2026-09-13, H4)", () => {
	const FOUR = ["e2e4", "d2d4", "g1f3", "c2c4"];
	const own = {
		fen: START,
		ply: 0,
		myClockMs: 180_000,
		oppClockMs: 180_000,
		timeControl: { baseMs: 180_000, incMs: 2_000 },
		tau: 0.5,
		budgetUsedRatio: 0,
		targetElo: 1500,
		form: 0,
	};

	it("ownMoveBudget carries humanDepth(selfElo) in Maia mode and nothing otherwise", () => {
		const s = strength({});
		const maia = ownMoveBudget({ ...own, maia: true }, s);
		expect(maia.featureDepth).toBe(humanDepth(ownMoveMaiaElo({ ...own, maia: true }, s).selfElo));
		expect(maia.featureDepth).toBe(humanDepth(1500));
		expect(ownMoveFeatureDepth({ ...own, maia: true }, s)).toBe(maia.featureDepth);
		expect(ownMoveBudget(own, s).featureDepth).toBeUndefined();
		expect(ownMoveBudget({ ...own, maia: false }, s).featureDepth).toBeUndefined();
		expect(ownMoveFeatureDepth(own, s)).toBeUndefined();
		// the slider moves the rating the frame is chosen for, exactly as it moves the query
		expect(ownMoveBudget({ ...own, maia: true }, strength({ blunderScale: 2 })).featureDepth).toBe(
			humanDepth(1500 - MAIA.slider.eloSpan)
		);
		// the pre-analysis contract: the same inputs give the same budget, frame included
		expect(ownMoveBudget({ ...own, maia: true }, s)).toEqual(
			ownMoveBudget({ ...own, maia: true }, s)
		);
	});

	it("the referee request asks for the human frame in Maia mode; the fallback path asks for none", async () => {
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		const out = await pipeline.run(input({ targetElo: 1500, settings: strength({}) }));
		expect(engine.requests[0]?.featureDepth).toBe(humanDepth(out?.rec.maia?.selfElo ?? 0));
		expect(out?.budget.featureDepth).toBe(engine.requests[0]?.featureDepth);
		const plain = fakeEngine((req) => analysisOf(req, FOUR, 14));
		await new RecommendationPipeline({ engine: plain, timing: model(), book: null }).run(
			input({ targetElo: 1500, settings: strength({}) })
		);
		expect(plain.requests[0]?.featureDepth).toBeUndefined();
	});

	it("the shallow frame never reaches rec.eval or rec.lines", async () => {
		const engine = fakeEngine((req) => {
			const r = analysisOf(req, FOUR, 14, [30, 20, 10, 0]);
			r.atFeatureDepth = {
				...r.final,
				depth: req.featureDepth ?? 0,
				lines: lines(["c2c4", "g1f3", "d2d4", "e2e4"], req.featureDepth ?? 0, [500, 400, 300, 200]),
			};
			return r;
		});
		const { port } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		const out = await pipeline.run(input({ targetElo: 1500, settings: strength({}) }));
		expect(out?.rec.eval).toEqual({ cp: 30 });
		expect(out?.rec.lines.map((l) => l.pvUci[0])).toEqual(FOUR);
		expect(out?.rec.lines.every((l) => l.depth === 14)).toBe(true);
		expect(out?.rec.depth).toBe(14);
		expect(out?.rec.chosen.source).toBe("maia");
	});
});

// Owner, 2026-09-15: "we just go straight from that to big net at 3000". This block pinned the
// Maia-79M prior over (3000, 3200] — a capped query and a 12-root native referee; the band is
// removed, so it now pins the plain native search with no query above the cutoff.
describe("No Maia above the cutoff: straight to the full-network engine", () => {
	const SIX = ["e2e4", "d2d4", "g1f3", "c2c4", "b1c3", "g2g3"];

	it("above 3000 the referee is native at the ordinary breadth and Maia is never asked", async () => {
		for (const targetElo of [MAIA.eloMax + 1, 3100, 3200]) {
			const engine = fakeEngine((req) => analysisOf(req, SIX, 18));
			const { port, calls } = fakePolicy(async () => ({ ...MAIA_START, size: "79m" }));
			const pipeline = new RecommendationPipeline({
				engine,
				timing: model(),
				book: null,
				policy: port,
			});
			const out = await pipeline.run(
				input({ targetElo, settings: strength({ selectionMode: "hybrid" }) })
			);
			expect(calls).toHaveLength(0);
			expect(engine.requests).toHaveLength(1);
			expect(engine.requests[0]?.elo).toBe(requestEloForTarget(targetElo));
			expect(engine.requests[0]?.multiPv).toBe(6);
			expect(engine.requests[0]?.searchmoves).toBeUndefined();
			expect(engine.requests[0]?.featureDepth).toBeUndefined();
			expect(out?.rec.maia).toBeUndefined();
			expect(out?.rec.chosen.source).toBe("engine-elo");
			expect(out?.rec.chosen.uci).toBe("e2e4");
		}
	});

	it("no extra referee search above the cutoff either, and the top setting asks for nothing", async () => {
		const outside: PolicyResult = {
			...MAIA_START,
			size: "79m",
			moves: [
				["a2a3", 0.6],
				["e2e4", 0.4],
			],
		};
		const engine = fakeEngine((req) => analysisOf(req, SIX, 18));
		const { port, calls } = fakePolicy(async () => outside);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
		});
		await pipeline.run(input({ targetElo: 3100, settings: strength({}) }));
		expect(calls).toHaveLength(0);
		expect(engine.requests).toHaveLength(1);
		expect(engine.requests[0]?.searchmoves).toBeUndefined();
		const top = fakeEngine((req) => analysisOf(req, SIX, 18));
		const topPort = fakePolicy(async () => outside);
		await new RecommendationPipeline({
			engine: top,
			timing: model(),
			book: null,
			policy: topPort.port,
		}).run(input({ targetElo: 3800, settings: strength({}) }));
		expect(topPort.calls).toHaveLength(0);
		expect(top.requests[0]?.multiPv).toBe(6);
	});
});

describe("Maia plays the opening below BOOK.maiaOnlyElo (2026-09-13, H14.2)", () => {
	const FOUR = ["e2e4", "d2d4", "g1f3", "c2c4"];
	const bookMove: ChosenMove = {
		uci: "c2c4",
		san: "c4",
		from: "c2",
		to: "c4",
		source: "book",
		rankInLines: 0,
		cpLoss: 0,
		rationale: ["book"],
	};
	const bookOf = (answer: ChosenMove | null): BookPolicy => ({
		bookMove: async () => answer,
		dispose: () => {},
	});

	it("maiaPlaysOpening: by effective E, only where Maia selects", () => {
		expect(maiaPlaysOpening({ targetElo: 1500, form: 0 })).toBe(true);
		expect(maiaPlaysOpening({ targetElo: BOOK.maiaOnlyElo - 1, form: 0 })).toBe(true);
		expect(maiaPlaysOpening({ targetElo: BOOK.maiaOnlyElo, form: 0 })).toBe(false);
		// form moves E: 1650 + 150·0.5 = 1725
		expect(maiaPlaysOpening({ targetElo: 1650, form: 0.5 })).toBe(false);
		expect(maiaPlaysOpening({ targetElo: 1650, form: -0.5 })).toBe(true);
		expect(maiaPlaysOpening({ targetElo: 800, form: 0 })).toBe(true);
		expect(maiaPlaysOpening({ targetElo: MAIA.eloMax, form: -1 })).toBe(false);
	});

	it("the book stands down for Maia and only the chosen familiar move gets book timing", async () => {
		const engine = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const { port } = fakePolicy(async () => MAIA_START);
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: bookOf(bookMove),
			policy: port,
		});
		const out = await pipeline.run(input({ targetElo: 1500 }));
		expect(out?.rec.chosen.source).toBe("maia");
		expect(out?.fromBook).toBe(false);
		expect(out?.rec.chosen.uci).not.toBe(bookMove.uci);
		expect(out?.rec.plan.features.in_book).toBe(0);
		// from `BOOK.maiaOnlyElo` the book answers first, as before
		const above = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const kept = await new RecommendationPipeline({
			engine: above,
			timing: model(),
			book: bookOf(bookMove),
			policy: fakePolicy(async () => MAIA_START).port,
		}).run(input({ targetElo: BOOK.maiaOnlyElo }));
		expect(kept?.rec.chosen.source).toBe("book");
		expect(kept?.fromBook).toBe(true);
		expect(kept?.rec.plan.features.in_book).toBe(1);
		// no answer in budget: the engine-fallback move keeps the book
		const fallback = fakeEngine((req) => analysisOf(req, FOUR, 14));
		const still = await new RecommendationPipeline({
			engine: fallback,
			timing: model(),
			book: bookOf(bookMove),
			policy: fakePolicy(async () => null).port,
		}).run(input({ targetElo: 1500 }));
		expect(still?.rec.chosen.source).toBe("book");
		expect(still?.fromBook).toBe(true);
		// without a port nothing changes either
		const none = await new RecommendationPipeline({
			engine: fakeEngine((req) => analysisOf(req, FOUR, 14)),
			timing: model(),
			book: bookOf(bookMove),
		}).run(input({ targetElo: 1500 }));
		expect(none?.rec.chosen.source).toBe("book");
	});

	it("out of book, an early move Maia is confident of is still in_book for timing; a late one is not", async () => {
		const confident: PolicyResult = {
			...MAIA_START,
			moves: [
				["d2d4", 0.97],
				["e2e4", 0.03],
			],
		};
		// ply 20 is past the timing features' own early-top-line rule (`bookMaxPly` 16), so `in_book`
		// here can only come from the pipeline's flag
		const early = await new RecommendationPipeline({
			engine: fakeEngine((req) => analysisOf(req, FOUR, 14)),
			timing: model(),
			book: bookOf(null),
			policy: fakePolicy(async () => confident).port,
		}).run(input({ targetElo: 1500, snapshot: snapshot({ ply: 20 }) }));
		expect(early?.rec.chosen.uci).toBe("d2d4");
		expect(early?.rec.chosen.maiaProb).toBe(0.97);
		expect(early?.fromBook).toBe(false);
		expect(early?.rec.plan.features.in_book).toBe(1);
		const late = await new RecommendationPipeline({
			engine: fakeEngine((req) => analysisOf(req, FOUR, 14)),
			timing: model(),
			book: bookOf(null),
			policy: fakePolicy(async () => confident).port,
		}).run(input({ targetElo: 1500, snapshot: snapshot({ ply: BOOK.maxPly + 1 }) }));
		expect(late?.rec.chosen.uci).toBe("d2d4");
		expect(late?.rec.plan.features.in_book).toBe(0);
		// and the same early confident move at 1800 (book kept, out of book here) is not in_book
		const strong = await new RecommendationPipeline({
			engine: fakeEngine((req) => analysisOf(req, FOUR, 14)),
			timing: model(),
			book: bookOf(null),
			policy: fakePolicy(async () => confident).port,
		}).run(input({ targetElo: 1800, snapshot: snapshot({ ply: 20 }) }));
		expect(strong?.rec.plan.features.in_book).toBe(0);
	});
});

describe("one Maia-shaped search (2026-09-13, H10 / H17)", () => {
	const FOUR = ["e2e4", "d2d4", "g1f3", "c2c4"];
	const K = MAIA_SEARCH.shaped;
	/** A real engine answers a restricted search with exactly its roots, all in one frame. */
	const referee = (req: AnalysisRequest): AnalysisResult =>
		analysisOf(req, req.searchmoves ?? FOUR, 14);
	const pipelineWith = (engine: ReturnType<typeof fakeEngine>, port?: PolicyPort) =>
		new RecommendationPipeline({
			now: () => NOW,
			engine,
			timing: model(),
			book: null,
			...(port ? { policy: port } : {}),
		});
	const held = heldPolicy;
	const policyOf = (moves: Array<[string, number]>): PolicyResult => ({ ...MAIA_START, moves });
	const CONFIDENT = policyOf([
		["e2e4", 0.97],
		["d2d4", 0.01],
		["g1f3", 0.01],
		["c2c4", 0.01],
	]);
	const BUDGET = { movetimeMs: 600, depthCap: 20, multiPv: 20, featureDepth: 6 };

	it("shapedRootSet: Maia's top-k to massCover, filled to minRoots, plus the known top moves, sorted", () => {
		// eight at 0.11 (0.88), then 0.05 (0.93), then 0.04 (0.97 ≥ 0.95): ten roots
		const spread = policyOf([
			...["e2e4", "d2d4", "g1f3", "c2c4", "b1c3", "g2g3", "e2e3", "d2d3"].map(
				(uci): [string, number] => [uci, 0.11]
			),
			["a2a3", 0.05],
			["h2h3", 0.04],
			["b2b3", 0.03],
		]);
		expect(shapedRootSet(spread, START)).toEqual(
			["e2e4", "d2d4", "g1f3", "c2c4", "b1c3", "g2g3", "e2e3", "d2d3", "a2a3", "h2h3"].sort()
		);
		// one move carries the mass: Maia's next-ranked fill to minRoots
		expect(shapedRootSet(CONFIDENT, START)).toEqual(["c2c4", "d2d4", "e2e4", "g1f3"]);
		expect(K.minRoots).toBe(4);
		// the known top moves are forced in (at most `knownTopMoves` of them); an illegal one and a
		// duplicate are skipped and do not count
		expect(shapedRootSet(CONFIDENT, START, ["e2e4", "e2e5", "a2a3", "h2h3", "b2b3", "g2g3"])).toEqual(
			["a2a3", "b2b3", "e2e4", "h2h3"]
		);
		expect(K.knownTopMoves).toBe(3);
		// the same set whatever order Maia's list arrives in
		const reversed = policyOf([...spread.moves].reverse());
		expect(shapedRootSet(reversed, START)).toEqual(shapedRootSet(spread, START));
		// an illegal-only or empty answer shapes nothing
		expect(shapedRootSet(policyOf([["e2e5", 1]]), START)).toEqual([]);
		expect(shapedRootSet(policyOf([]), START)).toEqual([]);
	});

	it("shapedRootSet: never more than maxRoots of Maia's own moves", () => {
		const flat = policyOf(legalMovesOf(START).map((uci): [string, number] => [uci, 0.05]));
		expect(shapedRootSet(flat, START)).toHaveLength(K.maxRoots);
		expect(K.maxRoots).toBe(12);
		// …but the known top moves ride on top of the cap
		expect(shapedRootSet(flat, START, ["h2h4", "g2g4", "f2f4"])).toHaveLength(K.maxRoots + 3);
	});

	it("shapedSearchPlan: multiPv is the root count; H17 shrinks the movetime toward the floor only when Maia is confident", () => {
		const plain = shapedSearchPlan(MAIA_START, START, ["e2e4"], BUDGET);
		expect(plain?.searchmoves).toEqual(shapedRootSet(MAIA_START, START));
		expect(plain?.budget).toEqual({ ...BUDGET, multiPv: 4, movetimeMs: 600 });
		expect(plain?.confident).toBe(false);
		const confident = shapedSearchPlan(CONFIDENT, START, ["e2e4"], BUDGET);
		const floor = SEARCH_BUDGET.minMovetimeMs;
		expect(confident?.budget.movetimeMs).toBe(600 - K.confidentTimeFraction * (600 - floor));
		expect(confident?.budget.movetimeMs).toBe(375);
		expect(confident?.confident).toBe(true);
		// never below the floor: the panel still needs an eval
		expect(
			shapedSearchPlan(CONFIDENT, START, ["e2e4"], { ...BUDGET, movetimeMs: floor })?.budget.movetimeMs
		).toBe(floor);
		expect(K.confidentProb).toBe(0.8);
		expect(shapedSearchPlan(policyOf([["e2e5", 1]]), START, undefined, BUDGET)).toBeNull();
	});

	it("a held answer with the pre-analysis's known top moves issues exactly one shaped search and no extra search", async () => {
		const known = ["e2e4", "d2d4", "g1f3"];
		const roots = shapedRootSet(MAIA_OUTSIDE, START, known);
		expect(roots).toContain("b1c3");
		expect(roots).toEqual(expect.arrayContaining(known));
		const picks = new Set<string>();
		for (let seed = 0; seed < 12; seed++) {
			const engine = fakeEngine(referee);
			const { port, calls } = fakePolicy(async () => MAIA_OUTSIDE);
			const out = await pipelineWith(engine, port).run(
				input({
					targetElo: 1500,
					settings: strength({}),
					policyAnswer: held(MAIA_OUTSIDE, known),
					rng: createRng(`shaped-${seed}`),
				})
			);
			expect(calls).toHaveLength(0);
			expect(engine.requests).toHaveLength(1);
			const req = engine.requests[0];
			expect(req?.searchmoves).toEqual(roots);
			expect(req?.multiPv).toBe(roots.length);
			expect(req?.shaped).toBe(true);
			expect(req?.elo).toBeUndefined();
			expect(req?.priority).toBe("move");
			expect(req?.featureDepth).toBe(humanDepth(1500));
			expect(req?.limit.movetimeMs).toBe(600);
			// every candidate scored in one frame at one depth — the merged-frame defects (§7 A1/A2)
			// are unreachable: no line is shallower than the reference, no sample is depth-mismatched
			expect(out?.rec.lines.map((l) => l.pvUci[0])).toEqual(roots);
			expect(out?.rec.lines.every((l) => l.depth === 14)).toBe(true);
			expect(out?.rec.lines.map((l) => l.multipv)).toEqual(roots.map((_, i) => i + 1));
			expect(out?.rec.chosen.source).toBe("maia");
			expect(out?.rec.chosen.quality?.eligible).toBe(true);
			expect(out?.rec.chosen.rationale.join(" ")).not.toContain("searchmoves");
			expect(out?.budget.multiPv).toBe(roots.length);
			picks.add(out?.rec.chosen.uci ?? "");
		}
		// half of Maia's mass is on b1c3, a root of the one search: twelve seeds cannot all miss it
		expect(picks.has("b1c3")).toBe(true);
	});

	it("a fresh answer shapes the engine and Maia roots; a slow answer uses the broad search", async () => {
		const engine = fakeEngine(referee);
		const { port, calls } = fakePolicy(async () => MAIA_OUTSIDE);
		const out = await pipelineWith(engine, port).run(
			input({ targetElo: 1500, settings: strength({}) })
		);
		expect(calls).toHaveLength(1);
		expect(engine.requests).toHaveLength(2);
		expect(engine.requests[0]?.searchmoves).toBeUndefined();
		expect(engine.requests[1]?.searchmoves).toEqual(shapedRootSet(MAIA_OUTSIDE, START, FOUR));
		expect(engine.requests[1]?.shaped).toBe(true);
		expect(out?.rec.chosen.source).toBe("maia");
		expect(out?.rec.maia?.selfElo).toBe(1500);

		// the same port, but the clock has passed `policyFirstMs` by the time the answer is read:
		// today's broad search (the sampling breadth, no restriction) and today's extra search
		const slow = fakeEngine((req) =>
			req.searchmoves ? analysisOf(req, req.searchmoves, 12) : analysisOf(req, FOUR, 14)
		);
		const late = await fallbackPipeline(slow, fakePolicy(async () => MAIA_OUTSIDE).port).run(
			input({ targetElo: 1500, settings: strength({}) })
		);
		expect(slow.requests).toHaveLength(3);
		expect(slow.requests[0]?.searchmoves).toBeUndefined();
		expect(slow.requests[0]?.shaped).toBeUndefined();
		expect(slow.requests[1]?.multiPv).toBe(20);
		expect(slow.requests[2]?.searchmoves).toEqual(["b1c3", "a2a3", "h2h3"]);
		expect(slow.requests[2]?.shaped).toBeUndefined();
		// the late answer still reaches the selector
		expect(late?.rec.chosen.source).toBe("maia");
	});

	it("a clock race and targets above the Maia cutoff are untouched: no shaped search, whatever is held", async () => {
		const race = fakeEngine(referee);
		const { port, calls } = fakePolicy(async () => MAIA_OUTSIDE);
		const out = await pipelineWith(race, port).run(
			input({
				targetElo: 1500,
				settings: strength({}),
				policyAnswer: held(MAIA_OUTSIDE, FOUR),
				snapshot: snapshot({
					clocks: { w: { ms: 3000, running: true }, b: { ms: 90000, running: false } },
				}),
			})
		);
		expect(out?.rec.plan.features.clockRace).toBeGreaterThan(0);
		expect(calls).toHaveLength(0);
		expect(race.requests).toHaveLength(1);
		expect(race.requests[0]?.searchmoves).toBeUndefined();
		expect(race.requests[0]?.elo).toBe(requestEloForTarget(1500));
		// Above MAIA.eloMax there is no Maia at all since 2026-09-15 (this pinned the removed prior's
		// 12-root search): the held answer is ignored and the search is the plain native one.
		const high = fakeEngine((req) => analysisOf(req, [...FOUR, "b1c3", "g2g3"], 14));
		const highPolicy = fakePolicy(async () => MAIA_OUTSIDE);
		await pipelineWith(high, highPolicy.port).run(
			input({ targetElo: 3100, settings: strength({}), policyAnswer: held(MAIA_OUTSIDE, FOUR) })
		);
		expect(highPolicy.calls).toHaveLength(0);
		expect(high.requests).toHaveLength(1);
		expect(high.requests[0]?.searchmoves).toBeUndefined();
		expect(high.requests[0]?.shaped).toBeUndefined();
		expect(high.requests[0]?.elo).toBe(requestEloForTarget(3100));
	});

	it("H17: a confident Maia shrinks the search's movetime toward the floor; the request and the outcome's budget agree", async () => {
		const engine = fakeEngine(referee);
		const out = await pipelineWith(engine, fakePolicy(async () => CONFIDENT).port).run(
			input({ targetElo: 1500, settings: strength({}), policyAnswer: held(CONFIDENT, FOUR) })
		);
		expect(engine.requests).toHaveLength(1);
		expect(engine.requests[0]?.limit.movetimeMs).toBe(375);
		expect(engine.requests[0]?.limit.depth).toBe(out?.budget.depthCap);
		expect(out?.budget.movetimeMs).toBe(375);
		// the panel still gets an eval from the shaped frame
		expect(out?.rec.eval).toEqual({ cp: 30 });
		expect(out?.rec.lines).toHaveLength(4);
		// and an unconfident answer keeps the class budget
		const plain = fakeEngine(referee);
		await pipelineWith(plain, fakePolicy(async () => MAIA_OUTSIDE).port).run(
			input({ targetElo: 1500, settings: strength({}), policyAnswer: held(MAIA_OUTSIDE, FOUR) })
		);
		expect(plain.requests[0]?.limit.movetimeMs).toBe(600);
	});
});

describe("one turn's clock and preparation deadline", () => {
	it("ages only the running clock before budgeting search and timing", async () => {
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 14));
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			now: () => NOW,
		});
		const out = await pipeline.run(
			input({
				snapshot: snapshot({
					capturedAt: NOW - 8000,
					clocks: { w: { ms: 10_000, running: true }, b: { ms: 90_000, running: false } },
					timeControl: { baseMs: 180_000, incMs: 0 },
				}),
			})
		);
		expect(out).not.toBeNull();
		expect(out?.rec.plan.features.clock_s).toBe(2);
		expect(out?.rec.plan.features.clockRace).toBeGreaterThan(0);
		expect(engine.requests[0]?.limit.movetimeMs).toBeLessThan(150);
		expect(out?.rec.computedAt).toBe(NOW);
		expect(out?.rec.plan.deadlineMs).toBe(NOW + (out?.rec.plan.thinkMs ?? 0));
	});

	it("does not append an extra referee search after policy and main search spend the deadline", async () => {
		let now = NOW;
		let release: (() => void) | undefined;
		const engine = fakeEngine((req) => {
			now += req.limit.movetimeMs ?? 0;
			release?.();
			return analysisOf(req, ["e2e4", "d2d4"], 14);
		});
		const { port } = fakePolicy(() => {
			now += MAIA_SEARCH.shaped.policyFirstMs + 1;
			return new Promise((resolve) => {
				release = () => resolve(MAIA_OUTSIDE);
			});
		});
		const pipeline = new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: port,
			now: () => now,
		});
		const out = await pipeline.run(input({ targetElo: 2400 }));
		expect(out).not.toBeNull();
		expect(engine.requests).toHaveLength(2);
		expect(engine.requests.reduce((sum, req) => sum + (req.limit.movetimeMs ?? 0), 0)).toBe(
			SEARCH_BUDGET.moveMs.blitz - MAIA_SEARCH.shaped.policyFirstMs - 1
		);
		expect(now - NOW).toBe(SEARCH_BUDGET.moveMs.blitz);
		expect(out?.rec.maia).toBeDefined();
	});

	it("cancels both model preparations when interrupted before a search starts", async () => {
		const ac = new AbortController();
		const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 14));
		const { port, signals } = fakePolicy(() => {
			ac.abort();
			return new Promise(() => {});
		});
		const timing = model();
		let preparationSignal: AbortSignal | undefined;
		const prepare = timing.prepare.bind(timing);
		timing.prepare = (ctx, options) => {
			preparationSignal = options?.signal;
			return prepare(ctx, options);
		};
		const pipeline = new RecommendationPipeline({
			engine,
			timing,
			book: null,
			policy: port,
			now: () => NOW,
		});
		expect(await pipeline.run(input({ signal: ac.signal }))).toBeNull();
		expect(engine.requests).toHaveLength(0);
		expect(signals[0]?.aborted).toBe(true);
		expect(preparationSignal?.aborted).toBe(true);
	});

	it("does not reduce strength merely because a rating's sustainable full-clock pace is quicker", () => {
		for (const targetElo of [500, 1200, 1800, 2400, 3000, 3800]) {
			for (const baseMs of [60_000, 180_000, 300_000, 600_000, 1_800_000]) {
				const context = ownMoveMaiaElo(
					{
						fen: START,
						ply: 0,
						myClockMs: baseMs,
						oppClockMs: baseMs,
						timeControl: { baseMs, incMs: 0 },
						tau: 0.5,
						budgetUsedRatio: 0,
						targetElo,
					},
					settings()
				);
				expect(context.contextEloPenalty).toBe(0);
			}
		}
	});
});

describe("selection routing and independent engine evidence", () => {
	it("routes every search using the active target despite a different saved slider", async () => {
		for (const targetElo of [500, 1500, 2600, 2800, 2801, 3000, 3001, 3200, 3201, 3800]) {
			const engine = fakeEngine((req) => analysisOf(req, req.searchmoves ?? ["e2e4", "d2d4"], 18));
			const { port, calls } = fakePolicy(async () => MAIA_START);
			const configured = strength({ targetElo: 900 });
			const out = await new RecommendationPipeline({
				engine,
				timing: model(),
				book: null,
				policy: port,
				now: () => NOW,
			}).run(input({ targetElo, settings: configured, opponentElo: 3400 }));
			expect(out).not.toBeNull();
			expect(engine.requests.length).toBeGreaterThan(0);
			for (const req of engine.requests) expect(req.targetElo).toBe(targetElo);
			// One division at the Maia cutoff since 2026-09-15 (Maia used to be asked through 3200).
			expect(calls).toHaveLength(targetElo <= MAIA.eloMax ? 1 : 0);
			if (calls[0]) {
				expect(calls[0].selfElo).toBeLessThanOrEqual(3000);
				expect(calls[0].oppoElo).toBe(3400);
			}
			if (targetElo > MAIA.eloMax) {
				expect(out?.rec.maia).toBeUndefined();
				expect(out?.rec.chosen.uci).toBe("e2e4");
			}
		}
	});

	// The query "mode" (Maia vs. the upper prior at 3100) went with the prior band on 2026-09-15;
	// that change is now a conditioning change inside Maia's range, at the cutoff itself.
	it("rejects a held answer when conditioning or repetition history changes", async () => {
		const repeats = ["g1f3", "g8f6", "f3g1", "f6g8"];
		const changes: Partial<RecommendationInput>[] = [
			{ targetElo: 1600 },
			{ opponentElo: 1600 },
			{ form: 0.5 },
			{ settings: strength({ selectionMode: "persona-sampling" }) },
			{ targetElo: MAIA.eloMax },
			{
				snapshot: snapshot({ fen: applyMoves(START, repeats)!, ply: 4 }),
				history: { fen: START, moves: repeats },
				moves: repeats,
			},
		];
		for (const change of changes) {
			const engine = fakeEngine((req) => analysisOf(req, ["e2e4", "d2d4"], 18));
			const { port, calls } = fakePolicy(async () => MAIA_START);
			const out = await new RecommendationPipeline({
				engine,
				timing: model(),
				book: null,
				policy: port,
				now: () => NOW,
			}).run(
				input({ settings: strength({}), policyAnswer: heldPolicy(MAIA_START, ["e2e4"]), ...change })
			);
			expect(out).not.toBeNull();
			expect(calls).toHaveLength(1);
		}
	});

	it("keeps an engine move missing from Maia in one coherent final comparison within 600 ms", async () => {
		let now = NOW;
		const policy: PolicyResult = {
			...MAIA_START,
			moves: [
				["e2e4", 0.97],
				["d2d4", 0.01],
				["g1f3", 0.01],
				["c2c4", 0.01],
			],
		};
		const engine = fakeEngine((req) => {
			now += req.limit.movetimeMs ?? 0;
			return req.searchmoves
				? analysisOf(
						req,
						["b1c3", ...req.searchmoves.filter((move) => move !== "b1c3")],
						16,
						[100, -100, -100, -100, -100]
					)
				: analysisOf(req, ["b1c3"], 12, [100]);
		});
		const out = await new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: fakePolicy(async () => policy).port,
			now: () => now,
		}).run(input({ targetElo: 3000, settings: strength({}) }));
		expect(engine.requests).toHaveLength(2);
		expect(engine.requests[0]?.searchmoves).toBeUndefined();
		expect(engine.requests[1]?.searchmoves).toContain("b1c3");
		expect(engine.requests[1]?.limit.movetimeMs).toBe(400);
		expect(now - NOW).toBe(600);
		expect(out?.rec.chosen.uci).toBe("b1c3");
		expect(out?.rec.lines.every((line) => line.depth === 16)).toBe(true);
	});

	it("keeps a completed unrestricted result when the narrowed search fails", async () => {
		const engine = fakeEngine((req) =>
			req.searchmoves ? null : analysisOf(req, ["b1c3", "e2e4"], 14, [100, -100])
		);
		const out = await new RecommendationPipeline({
			engine,
			timing: model(),
			book: null,
			policy: fakePolicy(async () => MAIA_START).port,
			now: () => NOW,
		}).run(input({ targetElo: 3000, settings: strength({}) }));
		expect(engine.requests).toHaveLength(2);
		expect(out?.analysis?.request.searchmoves).toBeUndefined();
		expect(out?.rec.chosen.uci).toBe("b1c3");
		expect(out?.rec.eval).toEqual({ cp: 100 });
	});

	it("does not narrow a root set without independent engine evidence or shorten upper verification", () => {
		const policy: PolicyResult = { ...MAIA_START, moves: [["e2e4", 1]] };
		const budget = { movetimeMs: 600, depthCap: 20, multiPv: 12 };
		expect(shapedSearchPlan(policy, START, undefined, budget, 3000)).toBeNull();
		expect(shapedSearchPlan(policy, START, ["e2e5"], budget, 3000)).toBeNull();
		expect(shapedSearchPlan(policy, START, ["b1c3"], budget, 2800)?.budget.movetimeMs).toBe(375);
		for (const target of [2801, 2900, 3000]) {
			expect(shapedSearchPlan(policy, START, ["b1c3"], budget, target)?.budget.movetimeMs).toBe(600);
		}
	});
});
