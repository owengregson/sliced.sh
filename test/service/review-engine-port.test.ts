import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
import { ENGINE_FILES } from "@core/constants/engine-files";
import type { GamePortCommand } from "@core/constants/messages";
import { PORT_NAMES } from "@core/constants/ports";
import type { AnalysisUpdate } from "@core/engine/types";
import { defaultScheduler } from "@core/util/scheduler";
import { EngineHost, type ServedEngine, serveEnginePort } from "@offscreen/engine-host";
import { BoardEffectsReporter } from "@service/game-session/board-effects";
import { ReviewEngine } from "@service/review-engine";
import { createSimulator, type Simulator } from "@test/sim";
import { bootOffscreenContext, type OffscreenContext } from "@test/sim/contexts/offscreen-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import { FakeStockfishWeb } from "../fakes/stockfish";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Real host/ports/UCI/reviewer; only the WASM command responses are scripted. */
describe("review engine over the offscreen port", () => {
	let sim: Simulator;
	let sw: SwContext;
	let off: OffscreenContext;
	let served: ServedEngine;
	let review: ReviewEngine;
	const boots: FakeStockfishWeb[] = [];
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 30; i++) await sim.time.runMicrotasks();
	};

	beforeEach(async () => {
		boots.length = 0;
		sim = createSimulator();
		sim.time.install();
		sw = await bootSwContext(sim);
		off = await bootOffscreenContext(sim, {
			entry: () => {
				served = serveEnginePort({
					portName: PORT_NAMES.reviewEngine,
					disposeOnDisconnect: true,
					createStore: () => ({ handleChunk: () => {}, abortAll: () => {} }),
					createHost: (post) =>
						new EngineHost({
							post,
							allowSmallnetFallback: false,
							nnueStore: { get: async () => new Uint8Array() },
							boot: async (_variant, hooks) => {
								const sf = new FakeStockfishWeb(ENGINE_FILES.full.nnue);
								sf.listen = hooks.listen;
								sf.onError = hooks.onError;
								sf.uci = (command) => {
									sf.commands.push(command);
									if (command === "uci") queueMicrotask(() => sf.emit("id name Stockfish 19", "uciok"));
									if (command === "isready") queueMicrotask(() => sf.emit("readyok"));
								};
								boots.push(sf);
								hooks.onLoadingNnue([...ENGINE_FILES.full.nnue]);
								return { sf, module: ENGINE_FILES.full.js, nnue: [...ENGINE_FILES.full.nnue] };
							},
						}),
				});
			},
		});
		review = await sw.run(() => new ReviewEngine({ ensureHost: async () => {}, threads: 2 }));
	});

	afterEach(async () => {
		review?.dispose();
		served?.stop();
		await off?.teardown();
		await sw?.teardown();
		sim.time.uninstall();
	});

	it("accepts the first search after UCI identifies the engine, including a fresh reboot", async () => {
		for (let boot = 0; boot < 2; boot++) {
			await sw.run(() => review.warm());
			const sf = boots[boot]!;
			for (let search = 0; search < 2; search++) {
				const handle = review.analyse({
					id: `review:${boot}:${search}`,
					fen: START,
					multiPv: 3,
					limit: { depth: 18, movetimeMs: 5000 },
				});
				const updates: AnalysisUpdate[] = [];
				const streamed = (async () => {
					for await (const update of handle.updates) updates.push(update);
				})().catch((error: unknown) => error);
				await settle();
				expect(sf.commands.some((command) => command.startsWith("go "))).toBe(true);
				sf.emit(
					"info depth 18 multipv 1 score cp 30 pv e2e4 e7e5",
					"info depth 18 multipv 2 score cp 20 pv d2d4 d7d5",
					"info depth 18 multipv 3 score cp 10 pv g1f3 g8f6",
					"bestmove e2e4"
				);
				await settle();
				const result = await handle.result;
				expect(result.status).toBe("complete");
				expect(result.final).toMatchObject({ depth: 18, complete: true });
				expect(await streamed).toBeUndefined();
				expect(updates.some((update) => update.complete && update.depth === 18)).toBe(true);
				expect(review.status()?.version).toBe("Stockfish 19");
			}
			review.release();
			await settle();
		}
		expect(boots).toHaveLength(2);
	});

	it("delivers a landed rating through the real port after both required frames complete", async () => {
		const posts: GamePortCommand[] = [];
		const reporter = new BoardEffectsReporter({
			reviewer: () => review,
			post: (command) => posts.push(command),
			scheduler: defaultScheduler,
			now: sim.now,
		});
		const ratings = () => posts.filter((command) => command.kind === "effects" && command.quality);
		try {
			// No explicit warm: a landed move opens the full cold-start host/port/UCI path.
			await sw.run(() =>
				reporter.report({
					moves: [
						{ beforeFen: START, historyFen: START, historyMoves: [], uci: "e2e4", ply: 0, mine: true },
					],
				})
			);
			await settle();
			expect(posts).toHaveLength(1); // immediate effects, without an unevaluated rating
			expect(ratings()).toHaveLength(0);
			expect(boots).toHaveLength(1);
			const sf = boots[0]!;
			expect(sf.commands.filter((command) => command.startsWith("go "))).toHaveLength(1);
			// e4 is deliberately outside MultiPV, so the before frame alone cannot grade it.
			sf.emit(
				"info depth 18 multipv 1 score cp 30 pv d2d4 d7d5",
				"info depth 18 multipv 2 score cp 20 pv g1f3 g8f6",
				"info depth 18 multipv 3 score cp 10 pv c2c4 e7e5",
				"bestmove d2d4"
			);
			await settle();
			await sw.run(() => sim.time.advance(1));
			expect(reporter.frameFor(START)?.depth).toBe(18);
			expect(ratings()).toHaveLength(0);
			expect(sf.commands.filter((command) => command.startsWith("go "))).toHaveLength(2);
			expect(sf.commands.filter((command) => command.startsWith("position ")).at(-1)).toBe(
				`position fen ${START} moves e2e4`
			);
			sf.emit(
				"info depth 18 multipv 1 score cp -30 pv e7e5 g1f3",
				"info depth 18 multipv 2 score cp -40 pv c7c5 g1f3",
				"info depth 18 multipv 3 score cp -50 pv e7e6 d2d4",
				"bestmove e7e5"
			);
			await settle();
			await sw.run(() => sim.time.advance(1));
			expect(reporter.frameFor(applyMoves(START, ["e2e4"])!)?.depth).toBe(18);
			expect(ratings()).toEqual([
				{ kind: "effects", effects: [], mine: true, quality: { square: "e4", quality: "best" } },
			]);
			expect(reporter.stats()).toEqual({ delivered: 1, dropped: {} });
			expect(review.status()?.version).toBe("Stockfish 19");
			expect(boots).toHaveLength(1);
		} finally {
			reporter.dispose();
		}
	});
});
