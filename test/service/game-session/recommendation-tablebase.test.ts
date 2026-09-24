// test/service/game-session/recommendation-tablebase.test.ts — the own-move pipeline with a fake
// tablebase: max strength plays the tables' move, human ratings only as the policy allows, and an
// absent, late, empty or foreign answer leaves the engine's move in place.
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { TABLEBASE_HUMAN } from "@core/constants/tablebase";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { createRng } from "@core/rng";
import { createSelectionState } from "@core/strength/move-selector";
import type { TablebasePort } from "@core/tablebase/client";
import { parseProbe, type TablebaseProbe } from "@core/tablebase/probe";
import { TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { timingSettingsFor } from "@service/game-session/presets";
import {
	type RecommendationInput,
	RecommendationPipeline,
} from "@service/game-session/recommendation";
import type { PositionSnapshot } from "@typedefs/game";
import { DEFAULT_SETTINGS, type Settings } from "@typedefs/settings";
import { apiAnswer, apiMove, KRK_WIN, KRK_WIN_FEN } from "../../core/tablebase/fixtures";

const NOW = 1_700_000_000_000;
const ENGINE_LINES = ["h1h5", "c2d3", "h1a1"];

function settings(useTablebase = true): Settings {
	return {
		...DEFAULT_SETTINGS,
		strength: { ...DEFAULT_SETTINGS.strength, useOpeningBook: false, useTablebase },
	};
}

function snapshot(fen = KRK_WIN_FEN): PositionSnapshot {
	return {
		site: "chesscom",
		gameId: "g1",
		fen,
		ply: 80,
		sideToMove: "w",
		myColor: "w",
		clocks: { w: { ms: 180_000, running: true }, b: { ms: 180_000, running: false } },
		timeControl: { baseMs: 180_000, incMs: 2_000 },
		capturedAt: NOW,
	};
}

/** The engine answers at once with `ENGINE_LINES`, best first; `onAnalyse` runs on every request. */
function engine(onAnalyse: () => void = () => {}, ucis: readonly string[] = ENGINE_LINES) {
	const requests: AnalysisRequest[] = [];
	return {
		requests,
		engineElo: () => undefined,
		analyse(req: AnalysisRequest): AnalysisHandle {
			requests.push(req);
			onAnalyse();
			const lines = ucis.map((uci, i) => ({
				multipv: i + 1,
				score: { cp: 900 - i },
				depth: 20,
				pvUci: [uci],
				pvSan: [uci],
			}));
			const result: AnalysisResult = {
				id: req.id,
				request: req,
				bestmove: ucis[0] ?? "",
				status: "complete",
				final: { id: req.id, depth: 20, lines, nodes: 1, nps: 1, timeMs: 1, complete: true },
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
		timingSettingsFor(DEFAULT_SETTINGS.timing, undefined),
		createRng("tb-timing")
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

function input(
	targetElo: number,
	seed: string,
	s = settings(),
	fen = KRK_WIN_FEN
): RecommendationInput {
	return {
		snapshot: snapshot(fen),
		settings: s,
		targetElo,
		persona: "balanced",
		form: 0,
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

function tablebase(answer: () => Promise<TablebaseProbe | null>) {
	const asked: string[] = [];
	const port: TablebasePort = {
		probe(fen) {
			asked.push(fen);
			return answer();
		},
	};
	return { port, asked };
}

function probeOf(json: Record<string, unknown>): TablebaseProbe {
	const p = parseProbe(json);
	if (!p) throw new Error("fixture does not parse");
	return p;
}

async function run(opts: {
	targetElo: number;
	seed?: string;
	tb: TablebasePort;
	settings?: Settings;
	now?: () => number;
	engine?: ReturnType<typeof engine>;
	fen?: string;
}) {
	const pipeline = new RecommendationPipeline({
		engine: opts.engine ?? engine(),
		timing: timing(opts.targetElo),
		book: null,
		tablebase: opts.tb,
		now: opts.now ?? (() => NOW),
	});
	return pipeline.run(input(opts.targetElo, opts.seed ?? "tb", opts.settings, opts.fen));
}

describe("RecommendationPipeline with a tablebase", () => {
	it("plays the tables' move at max strength, the engine breaking the tables' tie", async () => {
		const tb = tablebase(async () => probeOf(KRK_WIN));
		const out = await run({ targetElo: LIMITS.eloMax, tb: tb.port });
		expect(tb.asked).toEqual([KRK_WIN_FEN]);
		// c2c3 and c2d3 both zero in 25 plies; the engine ranks c2d3 higher.
		expect(out?.rec.chosen.uci).toBe("c2d3");
		expect(out?.rec.chosen.source).toBe("tablebase");
		expect(out?.rec.chosen.quality).toMatchObject({
			kind: "book",
			eligible: false,
			reason: "tablebase",
		});
		expect(out?.fromTablebase).toBe(true);
		expect(out?.fromBook).toBe(false);
		expect(out?.rec.chosen.rationale.some((r) => r.startsWith("tablebase: win"))).toBe(true);
		// The engine still searched: the timing model's features read its lines (C7).
		expect(out?.rec.lines.map((l) => l.pvUci[0])).toEqual(ENGINE_LINES);
	});

	it("plays the tables' move even when the engine found nothing", async () => {
		const tb = tablebase(async () => probeOf(KRK_WIN));
		const out = await run({ targetElo: LIMITS.eloMax, tb: tb.port, engine: engine(() => {}, []) });
		expect(out?.rec.chosen.source).toBe("tablebase");
		expect(out?.rec.chosen.uci).toBe("c2c3");
	});

	it("never asks when the setting is off", async () => {
		const tb = tablebase(async () => probeOf(KRK_WIN));
		const out = await run({ targetElo: LIMITS.eloMax, tb: tb.port, settings: settings(false) });
		expect(tb.asked).toHaveLength(0);
		expect(out?.rec.chosen.source).not.toBe("tablebase");
	});

	it("never asks outside the tables' range", async () => {
		const tb = tablebase(async () => probeOf(KRK_WIN));
		const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
		await run({
			targetElo: LIMITS.eloMax,
			tb: tb.port,
			fen: start,
			engine: engine(() => {}, ["e2e4", "d2d4"]),
		});
		expect(tb.asked).toHaveLength(0);
	});

	it("never asks below the human floor", async () => {
		const tb = tablebase(async () => probeOf(KRK_WIN));
		for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
			const out = await run({ targetElo: TABLEBASE_HUMAN.floorElo - 200, seed, tb: tb.port });
			expect(out?.rec.chosen.source).not.toBe("tablebase");
		}
		expect(tb.asked).toHaveLength(0);
	});

	it("asks only occasionally at a human rating, and plays the answer when it does", async () => {
		const tb = tablebase(async () => probeOf(KRK_WIN));
		let fromTables = 0;
		const n = 40;
		for (let i = 0; i < n; i += 1) {
			const out = await run({ targetElo: 2200, seed: `h${i}`, tb: tb.port });
			if (out?.rec.chosen.source === "tablebase") fromTables += 1;
		}
		expect(fromTables).toBe(tb.asked.length);
		expect(fromTables).toBeGreaterThan(0);
		expect(fromTables).toBeLessThan(n / 2);
	});

	it("keeps the engine's move when the tables have no answer", async () => {
		const tb = tablebase(async () => null);
		const out = await run({ targetElo: LIMITS.eloMax, tb: tb.port });
		expect(tb.asked).toHaveLength(1);
		expect(out?.rec.chosen.source).not.toBe("tablebase");
		expect(out?.rec.chosen.uci).toBe("h1h5");
	});

	it("keeps the engine's move when the answer holds no legal move", async () => {
		const tb = tablebase(async () => probeOf(apiAnswer("win", [apiMove("a1a8", "loss", -3)])));
		const out = await run({ targetElo: LIMITS.eloMax, tb: tb.port });
		expect(out?.rec.chosen.source).not.toBe("tablebase");
	});

	it("does not wait past the preparation deadline for a slow answer", async () => {
		let late = false;
		const tb = tablebase(() => new Promise<TablebaseProbe | null>(() => {}));
		const started = Date.now();
		const out = await run({
			targetElo: LIMITS.eloMax,
			tb: tb.port,
			// The clock jumps past every deadline once the engine has answered.
			engine: engine(() => {
				late = true;
			}),
			now: () => (late ? NOW + 3_600_000 : NOW),
		});
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(out?.rec.chosen.source).not.toBe("tablebase");
		expect(out?.rec.chosen.uci).toBe("h1h5");
	});

	it("survives a probe that throws", async () => {
		const port: TablebasePort = {
			probe() {
				throw new Error("boom");
			},
		};
		const out = await run({ targetElo: LIMITS.eloMax, tb: port });
		expect(out?.rec.chosen.uci).toBe("h1h5");
	});
});
