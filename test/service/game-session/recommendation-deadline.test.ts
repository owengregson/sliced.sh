import { describe, expect, it, spyOn } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MAIA_SEARCH, SEARCH_BUDGET } from "@core/constants/search";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import type { PolicyPort } from "@core/policy/types";
import { createRng } from "@core/rng";
import { createSelectionState } from "@core/strength/move-selector";
import { TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { timingSettingsFor } from "@service/game-session/presets";
import {
	type RecommendationInput,
	RecommendationPipeline,
} from "@service/game-session/recommendation";
import { pinIdentityCalibration } from "../../fakes/maia-calibration";

// These tests pin mechanics at the advertised rating; the calibration has its own tests.
pinIdentityCalibration();

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const TARGET = 3000;

function input(signal?: AbortSignal): RecommendationInput {
	const now = Date.now();
	return {
		snapshot: {
			site: "chesscom",
			gameId: "deadline",
			fen: FEN,
			ply: 0,
			sideToMove: "w",
			myColor: "w",
			clocks: { w: { ms: 180_000, running: true }, b: { ms: 180_000, running: false } },
			timeControl: { baseMs: 180_000, incMs: 2000 },
			capturedAt: now,
		},
		settings: {
			...DEFAULT_SETTINGS,
			strength: { ...DEFAULT_SETTINGS.strength, targetElo: TARGET, useOpeningBook: false },
		},
		targetElo: TARGET,
		persona: "balanced",
		form: 0,
		tau: 0.5,
		moves: [],
		expectedOppReply: null,
		oppThinkMsHistory: [],
		myThinkMsHistory: [],
		selectionState: createSelectionState(),
		budgetUsedRatio: 0,
		rng: createRng("pending-anchor"),
		nowMs: now,
		engineReady: true,
		autoQueen: true,
		inputMethod: "drag",
		...(signal ? { signal } : {}),
	};
}

function timing(): TimingModel {
	const model = new TimingModel(
		new V1ParametricHead(),
		timingSettingsFor(DEFAULT_SETTINGS.timing, undefined),
		createRng("timing")
	);
	model.startGame({
		targetElo: TARGET,
		profile: "balanced",
		baseSec: 180,
		incSec: 2,
		site: "chesscom",
		gameId: "deadline",
	});
	return model;
}

const policy: PolicyPort = {
	infer: async () => ({
		size: "79m",
		wdl: [0.3, 0.4, 0.3],
		moves: [
			["e2e4", 0.4],
			["d2d4", 0.3],
			["g1f3", 0.2],
			["c2c4", 0.1],
		],
	}),
	warm: () => {},
	dispose: () => {},
};

interface PendingSearch {
	request: AnalysisRequest;
	startedAt: number;
	stoppedAt: number[];
	finish(): void;
}

/** Searches never complete on their own: only the pipeline's real stop timer can release them. */
function pendingEngine(onStart?: (search: PendingSearch) => void) {
	const searches: PendingSearch[] = [];
	return {
		searches,
		engineElo: () => undefined,
		analyse(request: AnalysisRequest): AnalysisHandle {
			let resolve: (result: AnalysisResult) => void = () => {};
			const result = new Promise<AnalysisResult>((done) => {
				resolve = done;
			});
			const search: PendingSearch = {
				request,
				startedAt: Date.now(),
				stoppedAt: [],
				finish: () => {
					const roots = request.searchmoves ?? ["b1c3", "e2e4", "d2d4"];
					const depth = request.searchmoves ? 16 : 14;
					resolve({
						id: request.id,
						request,
						bestmove: roots[0] ?? null,
						status: "complete",
						final: {
							id: request.id,
							depth,
							complete: true,
							nodes: 1000,
							nps: 5000,
							timeMs: Date.now() - search.startedAt,
							lines: roots.map((uci, index) => ({
								multipv: index + 1,
								depth,
								score: { cp: 30 - index * 2 },
								pvUci: [uci],
								pvSan: [uci],
							})),
						},
					});
				},
			};
			searches.push(search);
			onStart?.(search);
			async function* updates(): AsyncGenerator<never> {}
			return {
				id: request.id,
				result,
				updates: updates(),
				stop: async () => {
					search.stoppedAt.push(Date.now());
					search.finish();
				},
			};
		},
	};
}

describe("recommendation anchor wall-clock deadlines", () => {
	it("stops a pending anchor at its own deadline and gives the main search only the residual budget", async () => {
		const engine = pendingEngine();
		const model = timing();
		const planned = spyOn(model, "planMove");
		const args = input();
		const started = Date.now();
		try {
			const outcome = await new RecommendationPipeline({
				engine,
				timing: model,
				book: null,
				policy,
			}).run(args);
			expect(outcome).not.toBeNull();
			expect(engine.searches).toHaveLength(2);
			const [anchor, main] = engine.searches as [PendingSearch, PendingSearch];
			const totalMs = SEARCH_BUDGET.moveMs.blitz;
			const anchorMs = Math.min(
				MAIA_SEARCH.shaped.anchorMaxMs,
				totalMs * MAIA_SEARCH.shaped.anchorFraction
			);
			expect(anchor.request.searchmoves).toBeUndefined();
			expect(anchor.request.limit.movetimeMs).toBeLessThanOrEqual(anchorMs);
			expect(anchor.stoppedAt).toHaveLength(1);
			expect(anchor.stoppedAt[0]! - anchor.startedAt).toBeGreaterThanOrEqual(anchorMs - 35);
			expect(anchor.stoppedAt[0]! - anchor.startedAt).toBeLessThan(anchorMs + 180);
			expect(main.startedAt).toBeGreaterThanOrEqual(anchor.stoppedAt[0]!);
			expect(main.request.searchmoves).toContain("b1c3");
			const residualMs = totalMs - (main.startedAt - started);
			expect(main.request.limit.movetimeMs).toBeGreaterThan(0);
			expect(Math.abs(main.request.limit.movetimeMs! - residualMs)).toBeLessThanOrEqual(35);
			expect(main.request.limit.movetimeMs).toBeLessThan(totalMs - anchorMs + 35);
			expect(main.stoppedAt).toHaveLength(1);
			expect(main.stoppedAt[0]! - started).toBeGreaterThanOrEqual(totalMs - 35);
			expect(main.stoppedAt[0]! - started).toBeLessThan(totalMs + 180);
			expect(planned).toHaveBeenCalledTimes(1);
		} finally {
			for (const search of engine.searches) search.finish();
			planned.mockRestore();
		}
	});

	it("aborting during a pending anchor stops it without dispatching the main search or publishing a plan", async () => {
		const ac = new AbortController();
		let abortTimer: ReturnType<typeof setTimeout> | undefined;
		const engine = pendingEngine(() => {
			abortTimer = setTimeout(() => ac.abort(), 30);
		});
		const model = timing();
		const planned = spyOn(model, "planMove");
		try {
			const outcome = await new RecommendationPipeline({
				engine,
				timing: model,
				book: null,
				policy,
			}).run(input(ac.signal));
			expect(ac.signal.aborted).toBe(true);
			expect(outcome).toBeNull();
			expect(engine.searches).toHaveLength(1);
			const anchor = engine.searches[0]!;
			expect(anchor.request.searchmoves).toBeUndefined();
			expect(anchor.stoppedAt).toHaveLength(1);
			expect(anchor.stoppedAt[0]! - anchor.startedAt).toBeGreaterThanOrEqual(20);
			expect(anchor.stoppedAt[0]! - anchor.startedAt).toBeLessThan(MAIA_SEARCH.shaped.anchorMaxMs);
			await new Promise((resolve) => setTimeout(resolve, MAIA_SEARCH.shaped.anchorMaxMs + 25));
			expect(engine.searches).toHaveLength(1);
			expect(anchor.stoppedAt).toHaveLength(1);
			expect(planned).not.toHaveBeenCalled();
		} finally {
			clearTimeout(abortTimer);
			ac.abort();
			for (const search of engine.searches) search.finish();
			planned.mockRestore();
		}
	});
});
