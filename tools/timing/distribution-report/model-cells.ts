/**
 * tools/timing/distribution-report/model-cells.ts — the timing model's plans on fixed recorded
 * positions, repeated per (rating × time control × clock fraction) cell through the real
 * ChessMimic head under the vendored onnxruntime.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyMoves } from "@core/chess/san";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { TimingModel } from "@core/timing/timing-model";
import type { TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";
import { timingSettingsFor } from "@service/game-session/presets";
import corpus from "../../../test/fixtures/timing/pgn-replay.json";
import { ROOT } from "../../lib/paths";
import { thinkStats } from "./think-stats";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const SAMPLES = 256;

/** The first analysed position from ply 22 on of each of the corpus's first four games. */
export function middlegamePositions() {
	return corpus.games.slice(0, 4).map((game) => {
		let fen = START;
		const moves: string[] = [];
		for (const [ply, record] of game.plies.entries()) {
			if (ply >= 22 && "lines" in record && record.lines.length > 0)
				return { fen, moves: [...moves], ply, record, myColor: game.myColor as "w" | "b" };
			moves.push(record.uci);
			fen = applyMoves(fen, [record.uci]) ?? "";
		}
		throw new Error(`No analyzed middle-game position in ${game.id}`);
	});
}
type Position = ReturnType<typeof middlegamePositions>[number];

export async function modelCells(positions: Position[]): Promise<unknown[]> {
	const inference = createTimingInference({
		runtime: () =>
			createOrtRuntime({
				importModule: (url) => import(url),
				getUrl: (p) => pathToFileURL(path.join(ROOT, p)).href,
				threads: 1,
			}),
		store: {
			get: async (name) =>
				new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, name)).arrayBuffer()),
		},
	});
	const cells: unknown[] = [];
	try {
		for (const targetElo of [800, 1600, 2400, 2800]) {
			for (const [baseSec, incSec] of [
				[60, 0],
				[180, 0],
				[180, 2],
				[600, 5],
			]) {
				if (baseSec === undefined || incSec === undefined) continue;
				for (const fraction of [0.7, 0.4, 0.15]) {
					const values: number[] = [];
					const raw: number[] = [];
					let capBound = 0;
					for (const [position, source] of positions.entries()) {
						const head = new ChessMimicHead({
							infer: async (inputs) => {
								const response = await inference.handle({
									kind: "timing",
									id: "distribution",
									inputs,
								});
								if (!response.probs) throw new Error(`Inference failed for ${inputs.band}`);
								return { probs: response.probs, band: response.band ?? inputs.band };
							},
							fallback: new V1ParametricHead(),
							budgetMs: 60_000,
						});
						const gameId = `distribution-${targetElo}-${baseSec}-${incSec}-${fraction}-${position}`;
						const model = new TimingModel(
							head,
							timingSettingsFor(DEFAULT_SETTINGS.timing, {
								baseMs: baseSec * 1000,
								incMs: incSec * 1000,
							}),
							createRng(gameId)
						);
						model.startGame({
							gameId,
							targetElo,
							baseSec,
							incSec,
							profile: "balanced",
							site: "chesscom",
						});
						const context: TimingContext = {
							fen: source.fen,
							moves: source.moves,
							ply: source.ply,
							myColor: source.myColor,
							chosenMove: source.record.uci,
							lines: source.record.lines ?? [],
							evalBeforeOppMove: null,
							expectedOppReply: null,
							myClockMs: baseSec * fraction * 1000,
							oppClockMs: baseSec * fraction * 1000,
							baseSec,
							incSec,
							oppThinkMsHistory: [],
							myThinkMsHistory: [],
							site: "chesscom",
							targetElo,
							profile: "balanced",
							engineReady: true,
							inputMethod: "drag",
							autoQueen: true,
							nowMs: 1_000_000,
						};
						await head.prepare(context);
						if (head.diagnostics(context.fen).head !== "chessmimic")
							throw new Error("Unexpected fallback");
						for (let i = 0; i < SAMPLES; i++) {
							const plan = model.planMove(context);
							values.push(plan.thinkMs / 1000);
							if (plan.features.headSampleSec !== undefined) raw.push(plan.features.headSampleSec);
							if (plan.rationale.some((r) => r.startsWith("cap "))) capBound++;
						}
					}
					cells.push({
						targetElo,
						baseSec,
						incSec,
						fraction,
						...thinkStats(values),
						capBound: capBound / values.length,
						...(raw.length ? { raw: thinkStats(raw) } : {}),
					});
				}
			}
			process.stderr.write(`Completed Elo ${targetElo}\n`);
		}
	} finally {
		inference.dispose();
	}
	return cells;
}
