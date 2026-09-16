// test/service/game-session/recommendation-max-strength.test.ts — the own-move pipeline at max
// strength (owner, 2026-09-15: "just play the absolute best possible move in every situation"):
// the move search keeps the shape the timing features and the pre-analysis cache read, the book is
// never asked, and the engine's top line is chosen whatever the humanising settings say.
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { createRng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import { createSelectionState } from "@core/strength/move-selector";
import { TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { timingSettingsFor } from "@service/game-session/presets";
import {
	ownMoveBudget,
	type RecommendationInput,
	RecommendationPipeline,
} from "@service/game-session/recommendation";
import type { PositionSnapshot } from "@typedefs/game";
import { DEFAULT_SETTINGS, type Settings } from "@typedefs/settings";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const NOW = 1_700_000_000_000;

/** Every humanising knob turned towards "not the best move". */
const humanised: Settings = {
	...DEFAULT_SETTINGS,
	strength: {
		...DEFAULT_SETTINGS.strength,
		selectionMode: "persona-sampling",
		blunderScale: LIMITS.blunderScaleMax,
		useOpeningBook: true,
	},
};

function snapshot(): PositionSnapshot {
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
	};
}

/** Three near-equal roots, best first, answered at once. */
function engine() {
	const requests: AnalysisRequest[] = [];
	return {
		requests,
		engineElo: () => undefined,
		analyse(req: AnalysisRequest): AnalysisHandle {
			requests.push(req);
			const lines = ["e2e4", "d2d4", "g1f3"].map((uci, i) => ({
				multipv: i + 1,
				score: { cp: 30 - i },
				depth: 14,
				pvUci: [uci],
				pvSan: [uci],
			}));
			const result: AnalysisResult = {
				id: req.id,
				request: req,
				bestmove: "e2e4",
				status: "complete",
				final: { id: req.id, depth: 14, lines, nodes: 1, nps: 1, timeMs: 1, complete: true },
			};
			async function* none(): AsyncGenerator<never, void, unknown> {}
			return {
				id: req.id,
				updates: none(),
				result: Promise.resolve(result),
				stop: () => Promise.resolve(),
			};
		},
	};
}

function timing(targetElo: number): TimingModel {
	const model = new TimingModel(
		new V1ParametricHead(),
		timingSettingsFor(humanised.timing, undefined),
		createRng("max-timing")
	);
	model.startGame({
		targetElo,
		profile: "balanced",
		baseSec: 180,
		incSec: 2,
		site: "chesscom",
		gameId: "g1",
	});
	return model;
}

function input(targetElo: number, seed: string): RecommendationInput {
	return {
		snapshot: snapshot(),
		settings: humanised,
		targetElo,
		persona: "balanced",
		form: -1,
		tau: 0.5,
		moves: [],
		expectedOppReply: null,
		oppThinkMsHistory: [],
		myThinkMsHistory: [],
		selectionState: createSelectionState(),
		budgetUsedRatio: 0,
		rng: createRng(seed),
		nowMs: NOW,
		engineReady: true,
		autoQueen: true,
		inputMethod: "drag",
	};
}

describe("RecommendationPipeline at max strength", () => {
	it("never asks the book and plays the engine's top line whatever the selection settings", async () => {
		let bookCalls = 0;
		const book: BookPolicy = {
			bookMove: async () => {
				bookCalls += 1;
				return null;
			},
			dispose: () => {},
		};
		for (const seed of ["a", "b", "c", "d", "e"]) {
			const fake = engine();
			const pipeline = new RecommendationPipeline({
				engine: fake,
				timing: timing(LIMITS.eloMax),
				book,
				now: () => NOW,
			});
			const out = await pipeline.run(input(LIMITS.eloMax, seed));
			expect(out?.rec.chosen.uci).toBe("e2e4");
			expect(out?.rec.chosen.source).toBe("engine-elo");
			expect(out?.fromBook).toBe(false);
			expect(fake.requests[0]?.elo).toBeUndefined();
		}
		expect(bookCalls).toBe(0);
	});

	it("keeps the move search's request shape of a 3799 target (timing features, pre-analysis cache)", async () => {
		const shape = async (targetElo: number) => {
			const fake = engine();
			await new RecommendationPipeline({
				engine: fake,
				timing: timing(targetElo),
				book: null,
				now: () => NOW,
			}).run(input(targetElo, "shape"));
			const req = fake.requests[0];
			return {
				multiPv: req?.multiPv,
				depth: req?.limit.depth,
				elo: req?.elo,
				movetime: req?.limit.movetimeMs,
			};
		};
		expect(await shape(LIMITS.eloMax)).toEqual(await shape(LIMITS.eloMax - 1));
		const position = {
			fen: START,
			ply: 0,
			myClockMs: 180_000,
			oppClockMs: 180_000,
			tau: 0.5,
			budgetUsedRatio: 0,
		};
		for (const timeControl of [
			{ baseMs: 60_000, incMs: 0 },
			{ baseMs: 180_000, incMs: 2_000 },
			{ baseMs: 900_000, incMs: 10_000 },
			undefined,
		])
			expect(ownMoveBudget({ ...position, timeControl, targetElo: LIMITS.eloMax }, humanised)).toEqual(
				ownMoveBudget({ ...position, timeControl, targetElo: LIMITS.eloMax - 1 }, humanised)
			);
	});
});
