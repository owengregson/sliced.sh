import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { legalMoves } from "@core/chess/san";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { ENGINE_DIR } from "@core/constants/engine-files";
import type { EnginePortCommand, EnginePortMessage } from "@core/constants/messages";
import type { EngineTransport } from "@core/engine/types";
import { UciEngine } from "@core/engine/uci-client";
import { createRng } from "@core/rng";
import { createSelectionState } from "@core/strength/move-selector";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { bootEngine, type StockfishFactory } from "@offscreen/stockfish-loader";
import { EngineController } from "@service/engine-controller";
import { RecommendationPipeline } from "@service/game-session/recommendation";
import { createTimingInferPort, type TimingInferPort } from "@service/handlers/engine/timing-infer";
import corpus from "../fixtures/strength/stockfish18-blitz.json";

const ROOT = path.resolve(import.meta.dir, "../..");

async function nativeTimingPort() {
	const child = spawn(
		process.execPath,
		[path.join(import.meta.dir, "helpers/native-timing-process.ts")],
		{ cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }
	);
	const reader = createInterface({ input: child.stdout });
	const listeners = new Set<(message: EnginePortMessage) => void>();
	let failure = "";
	child.stderr.on("data", (data: Buffer) => {
		failure += data.toString();
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Native timing process did not warm: ${failure}`)),
				30000
			);
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`Native timing process exited ${code}: ${failure}`));
			});
			reader.on("line", (line) => {
				if (!line.startsWith("{")) return;
				const message = JSON.parse(line) as EnginePortMessage & { ready?: boolean };
				if (message.ready) {
					clearTimeout(timer);
					resolve();
					return;
				}
				for (const listener of listeners) listener(message);
			});
		});
	} catch (error) {
		reader.close();
		child.kill();
		throw error;
	}
	return {
		post: (command: EnginePortCommand) => {
			child.stdin.write(`${JSON.stringify(command)}\n`);
		},
		onMessage: (listener: (message: EnginePortMessage) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: () => {
			reader.close();
			child.kill();
		},
	};
}

describe("native Stockfish through the strength pipeline", () => {
	it.skipIf(typeof SharedArrayBuffer === "undefined")(
		"preserves rating, broad candidates and native timing through concurrent runtime processes",
		async () => {
			const listeners = new Set<(line: string) => void>();
			const sent: string[] = [];
			const errors: string[] = [];
			const sf = await bootEngine("smallnet", {
				crossOriginIsolated: true,
				getUrl: (file) => pathToFileURL(path.join(ROOT, file)).href,
				importModule: (url) => import(url) as Promise<{ default: StockfishFactory }>,
				nnueStore: {
					get: async (name) =>
						new Uint8Array(await Bun.file(path.join(ROOT, ENGINE_DIR, name)).arrayBuffer()),
				},
				listen: (line) => {
					for (const listener of listeners) listener(line);
				},
				onError: (message) => errors.push(message),
			});
			const transport: EngineTransport = {
				send: (line) => {
					sent.push(line);
					sf.uci(line);
				},
				onLine: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				onStatus: () => () => {},
				restart: async () => {
					throw new Error("Unexpected native engine restart");
				},
			};
			const engine = new UciEngine(transport);
			const settings = {
				...DEFAULT_SETTINGS,
				strength: { ...DEFAULT_SETTINGS.strength, targetElo: 2800, useOpeningBook: false },
			};
			const controller = new EngineController(engine, {
				getSettings: async () => settings,
				onSettingsChanged: () => () => {},
				env: { hardwareConcurrency: 1, sab: true },
			});
			let native: Awaited<ReturnType<typeof nativeTimingPort>> | undefined;
			let inferPort: TimingInferPort | undefined;
			try {
				await controller.init();
				native = await nativeTimingPort();
				inferPort = createTimingInferPort(native);
				const head = new ChessMimicHead({ infer: inferPort.infer, fallback: new V1ParametricHead() });
				const timing = new TimingModel(head, settings.timing, createRng("native-timing"));
				const pipeline = new RecommendationPipeline({ engine: controller, timing, book: null });
				for (const position of corpus.positions.filter((p) => p.K === 20).slice(0, 2)) {
					await controller.newGame(position.name);
					const result = await pipeline.run({
						snapshot: {
							site: "chesscom",
							gameId: position.name,
							fen: position.fen,
							ply: 20,
							sideToMove: "w",
							myColor: "w",
							clocks: { w: { ms: 90000, running: true }, b: { ms: 90000, running: false } },
							timeControl: { baseMs: 180000, incMs: 0 },
							capturedAt: Date.now(),
						},
						settings,
						targetElo: 1650,
						persona: "balanced",
						form: 0,
						moves: [],
						tau: 0.5,
						budgetUsedRatio: 0,
						expectedOppReply: null,
						oppThinkMsHistory: [],
						myThinkMsHistory: [],
						engineReady: true,
						inputMethod: "drag",
						autoQueen: true,
						nowMs: Date.now(),
						rng: createRng(position.name),
						selectionState: createSelectionState(),
					});
					expect(result?.analysis?.request.elo).toBe(1650);
					expect(result?.budget.movetimeMs).toBe(600);
					expect(result?.analysis?.request.multiPv).toBe(20);
					expect(result?.analysis?.final.complete).toBe(true);
					expect(result?.rec.lines).toHaveLength(20);
					expect(new Set(result?.rec.lines.map((line) => line.pvUci[0])).size).toBe(20);
					expect(new Set(result?.rec.lines.map((line) => line.depth)).size).toBe(1);
					expect(legalMoves(position.fen)).toContain(result?.rec.chosen.uci ?? "");
					expect(head.diagnostics(position.fen)).toEqual({ head: "chessmimic", band: "1500_1600" });
					expect(result?.rec.plan.rationale.join(" ")).toContain("chessmimic band=1500_1600");
					expect(inferPort.pendingCount()).toBe(0);
				}
				expect(sent).toContain("setoption name UCI_Elo value 1650");
				expect(sent).toContain("setoption name MultiPV value 20");
				expect(errors).toEqual([]);
			} finally {
				inferPort?.dispose();
				native?.dispose();
				controller.dispose();
				engine.dispose();
				sf.uci("quit");
			}
		},
		60000
	);
});
